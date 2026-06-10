#!/usr/bin/env node
/**
 * 2SOMEone 官方资讯机器人
 *
 * 流程：拉取 RSS → 过滤新鲜条目 → 用 bot 自己发过的泡泡去重 → 发布为泡泡动态。
 * 只依赖公开 v1 API + bot runtime key，与任何第三方机器人完全同构。
 *
 * 环境变量：
 *   TWOSOMEONE_BOT_API_KEY   必填，bot runtime key（sk_ 前缀），通过 `2s1 bot key rotate` 获取
 *   TWOSOMEONE_BASE_URL      可选，默认 https://2some.ren
 *   DRY_RUN                  可选，设为 1 时只打印将要发布的内容，不真实发布
 *   MAX_POSTS_PER_RUN        可选，单次运行最多发布条数，默认 3（防刷屏）
 *   FRESH_WINDOW_HOURS       可选，只发布最近 N 小时内的新闻，默认 24
 */

import { readFile } from "node:fs/promises";
import Parser from "rss-parser";

const BASE_URL = process.env.TWOSOMEONE_BASE_URL || "https://2some.ren";
const BOT_KEY = process.env.TWOSOMEONE_BOT_API_KEY;
const DRY_RUN = process.env.DRY_RUN === "1";
const MAX_POSTS_PER_RUN = Number(process.env.MAX_POSTS_PER_RUN) || 3;
const FRESH_WINDOW_HOURS = Number(process.env.FRESH_WINDOW_HOURS) || 24;

const MAX_CONTENT_LEN = 500; // 平台限制
const DEDUP_LOOKBACK = 50; // 读自己最近 N 条泡泡用于去重
const POST_INTERVAL_MS = 5000; // 连发间隔，对限流友好

if (!BOT_KEY) {
  console.error("缺少 TWOSOMEONE_BOT_API_KEY，请先 `2s1 bot key rotate` 获取 runtime key");
  process.exit(2);
}

// ---------- 平台 API ----------

async function api(path, { method = "GET", json } = {}) {
  const res = await fetch(new URL(path, BASE_URL), {
    method,
    headers: {
      "x-api-key": BOT_KEY,
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.success === false) {
    throw new Error(`${method} ${path} 失败 (${res.status}): ${body?.error ?? "unknown"}`);
  }
  return body;
}

/** 验证 runtime key 并返回 bot 身份 */
async function preflight() {
  const session = await api("/api/auth/get-session");
  const user = session?.user;
  if (!user?.id || user.accountType !== "bot") {
    throw new Error("提供的 key 不是 bot runtime key（accountType != bot）");
  }
  return user;
}

/** 读取 bot 自己最近发布的泡泡内容，用于无状态去重 */
async function fetchRecentContents(botUserId) {
  const data = await api(`/api/v1/bubbles?authorId=${encodeURIComponent(botUserId)}&limit=${DEDUP_LOOKBACK}`);
  return (data?.items ?? []).map((item) => item?.content ?? "");
}

async function postBubble(content) {
  const data = await api("/api/v1/bubbles", { method: "POST", json: { content } });
  return data?.id;
}

// ---------- RSS ----------

async function loadFeeds() {
  const raw = await readFile(new URL("./feeds.json", import.meta.url), "utf-8");
  const feeds = JSON.parse(raw);
  if (!Array.isArray(feeds) || feeds.length === 0) {
    throw new Error("feeds.json 必须是非空数组：[{ name, url }, ...]");
  }
  return feeds;
}

async function fetchFeedItems(feed, parser) {
  const parsed = await parser.parseURL(feed.url);
  return (parsed.items ?? [])
    .filter((item) => item.link && item.title)
    .map((item) => ({
      source: feed.name,
      title: item.title.trim(),
      link: item.link.trim(),
      summary: (item.contentSnippet ?? "").trim(),
      publishedAt: item.isoDate ? new Date(item.isoDate) : null,
    }));
}

// ---------- 内容组装 ----------

/** 把 @ 换成全角，避免摘要里的 @xxx 误触发平台 mention 通知 */
function sanitize(text) {
  return text.replaceAll("@", "＠").replace(/\s+/g, " ").trim();
}

function composeContent(item) {
  const header = `【${sanitize(item.source)}】${sanitize(item.title)}`;
  const link = item.link;
  // 预留 header + 两组空行 + link 之后的余量给摘要
  const budget = MAX_CONTENT_LEN - header.length - link.length - 4; // 4 = 两组 "\n\n"
  let summary = sanitize(item.summary);
  if (summary && budget > 20) {
    if (summary.length > budget) summary = `${summary.slice(0, budget - 1)}…`;
  } else {
    summary = "";
  }
  const parts = [header, summary, link].filter(Boolean);
  return parts.join("\n\n").slice(0, MAX_CONTENT_LEN);
}

// ---------- 主流程 ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const bot = await preflight();
  console.log(`✓ 以 @${bot.username ?? bot.id} 身份运行${DRY_RUN ? "（DRY RUN，不会真实发布）" : ""}`);

  const feeds = await loadFeeds();
  const parser = new Parser({ timeout: 15000 });

  // 单个源失败不影响其它源
  const results = await Promise.allSettled(feeds.map((feed) => fetchFeedItems(feed, parser)));
  const items = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      items.push(...result.value);
    } else {
      console.warn(`⚠ 源「${feeds[i].name}」拉取失败：${result.reason?.message ?? result.reason}`);
    }
  });
  console.log(`共拉取 ${items.length} 条候选`);

  // 只保留新鲜条目（含缺少 pubDate 的条目一律丢弃，避免倾倒历史存档）
  const freshAfter = Date.now() - FRESH_WINDOW_HOURS * 3600_000;
  const fresh = items.filter((item) => item.publishedAt && item.publishedAt.getTime() >= freshAfter);

  // 去重：链接出现在 bot 最近发过的泡泡内容里 → 已发布过
  const recentContents = await fetchRecentContents(bot.id);
  const seen = (link) => recentContents.some((content) => content.includes(link));
  const unseenByLink = new Map();
  for (const item of fresh) {
    if (!seen(item.link) && !unseenByLink.has(item.link)) unseenByLink.set(item.link, item);
  }

  // 按发布时间升序（先发旧的），单次最多 MAX_POSTS_PER_RUN 条
  const queue = [...unseenByLink.values()]
    .sort((a, b) => a.publishedAt - b.publishedAt)
    .slice(-MAX_POSTS_PER_RUN);

  if (queue.length === 0) {
    console.log("没有需要发布的新内容，本次结束");
    return;
  }

  let posted = 0;
  for (const item of queue) {
    const content = composeContent(item);
    if (DRY_RUN) {
      console.log(`\n----- DRY RUN（${content.length} 字） -----\n${content}`);
      continue;
    }
    try {
      const bubbleId = await postBubble(content);
      posted += 1;
      console.log(`✓ 已发布: ${item.title} → bubble ${bubbleId}`);
    } catch (err) {
      console.error(`✗ 发布失败: ${item.title} — ${err.message}`);
    }
    if (item !== queue.at(-1)) await sleep(POST_INTERVAL_MS);
  }
  console.log(DRY_RUN ? `DRY RUN 结束，候选 ${queue.length} 条` : `本次发布 ${posted}/${queue.length} 条`);
}

main().catch((err) => {
  console.error(`运行失败: ${err.message}`);
  process.exit(1);
});
