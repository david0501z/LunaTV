/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * drpyS 代理路由
 * 
 * 将 LunaTV 的苹果 CMS V10 API 请求转发到 drpyS T4 接口
 * 并对详情页的网盘播放链接做改写，使其通过 play 端点解析
 * 
 * 请求格式: /api/drpys?ac=videolist&wd=keyword (搜索)
 *          /api/drpys?ac=videolist&ids=xxx (详情)
 */
const DRPYS_BASE = process.env.DRPYS_BASE_URL || 'http://172.17.0.1:5757';
// drpyS 密码优先读取环境变量 DRPYS_PWD，yml 中可单独配置
const DRPYS_PWD = process.env.DRPYS_PWD || 'admin123';

function log(...args: unknown[]) {
  console.log('[drpys]', ...args);
}

// drpyS 源模块映射
const DRPYS_MODULES: Record<string, string> = {
  'drpys-wangpan': '网盘资源[搜]',
  'drpys-tgpan': 'TG盘搜[搜]',
  'drpys-baidupan': '百度盘[搜]',
  'drpys-xiongdi': '兄弟盘[搜]',
  'drpys-tg': 'TG搜[搜]',
  'drpys-muou': '木偶[盘]',
  'drpys-ali': '阿里云盘[盘]',
  'drpys-baidu': '百度网盘[盘]',
  'drpys-quark': '夸克网盘[盘]',
  'drpys-uc': 'UC网盘[盘]',
  'drpys-123': '123云盘[盘]',
  'drpys-tianyi': '天翼云盘[盘]',
  'drpys-xunlei': '迅雷网盘[盘]',
  'drpys-alist': 'Alist[盘]',
  'drpys-mobile': '移动云盘[盘]',
};

/**
 * 判断是否是网盘参数格式的播放链接
 * 如: /国漫/F 凡人/01...mp4*1100830236519*61669539107*773303697958675
 */
function isPanParam(str: string): boolean {
  return str.includes('*') && str.length > 10;
}

/**
 * 从 vod_play_from 提取源名称 (去掉 #1, #2 后缀)
 */
function extractFlag(flagStr: string): string {
  return flagStr.replace(/#\d+$/, '').trim();
}

/**
 * 将 drpyS 详情返回的 vod_play_url 改写为指向 play 端点的格式
 * 
 * 原始: filename.mp4$/国漫/...mp4*1100830236519*61669539107*773303697958675
 * 改写: filename.mp4/api/drpys/play?module=木偶[盘]&flag=百度&ids=110083...675
 */
function rewritePlayUrl(
  sourceBlocks: string[],
  sourceFlags: string[],
  moduleKey: string
): { newUrl: string; newFlags: string } {
  const newBlocks: string[] = [];

  for (let si = 0; si < sourceBlocks.length && si < sourceFlags.length; si++) {
    const flag = extractFlag(sourceFlags[si]);
    const episodes = sourceBlocks[si].split('#');
    const newEpisodes: string[] = [];

    for (const ep of episodes) {
      const dollarIdx = ep.indexOf('$');
      if (dollarIdx > 0 && dollarIdx < ep.length - 1) {
        const epName = ep.substring(0, dollarIdx).trim();
        const epId = ep.substring(dollarIdx + 1);
        // 只改写网盘参数格式的链接
        if (isPanParam(epId)) {
          const playPath = `/api/drpys/play?module=${encodeURIComponent(moduleKey)}&flag=${encodeURIComponent(flag)}&ids=${encodeURIComponent(epId)}`;
          newEpisodes.push(`${epName}$${playPath}`);
        } else {
          newEpisodes.push(ep); // 保持原样 (已经是标准 URL)
        }
      } else {
        newEpisodes.push(ep);
      }
    }

    newBlocks.push(newEpisodes.join('#'));
  }

  return {
    newUrl: newBlocks.join('$$$'),
    newFlags: sourceFlags.map(extractFlag).join('$$$'),
  };
}

/**
 * 将 URL 编码为 base64url 格式（只含 [\w-] 字符，兼容 detail 路由的 ID 校验）
 */
function encodeVodId(url: string): string {
  return Buffer.from(url, 'utf-8').toString('base64url');
}

/**
 * 将 base64url 格式解码回原 URL
 */
function decodeVodId(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString('utf-8');
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // 兼容两种调用方式：
  //   1. /api/drpys?module=drpys-muou&ac=videolist&wd=keyword
  //   2. /api/drpys/<模块名>?ac=videolist&wd=keyword   (path 形式)
  let mod = searchParams.get('module');

  // 从 path 中提取模块名 (如果有): /api/drpys/木偶[盘]
  // pathname 如 "/api/drpys" 或 "/api/drpys/play"
  const pathname = request.nextUrl.pathname;
  const pathMatch = pathname.match(/^\/api\/drpys\/(.+)$/);
  if (pathMatch) {
    const pathSeg = decodeURIComponent(pathMatch[1]);
    // path 形式不允许走 play (那是另一个路由的)
    if (pathSeg !== 'play') {
      // 取余下 path 段像模块名 (可能含 [盘] 等)
      mod = pathSeg;
    }
  }

  if (!mod) {
    log('无模块名, 返回模块列表');
    return NextResponse.json({ modules: Object.keys(DRPYS_MODULES) });
  }

  const moduleName = DRPYS_MODULES[mod] || mod;
  const isDetail = searchParams.has('ids') && !searchParams.has('play') && !searchParams.has('wd');
  const isSearch = searchParams.has('wd');

  log(`${isDetail ? '详情' : isSearch ? '搜索' : '其他'} 请求: mod=${mod} ids=${searchParams.get('ids')?.slice(0, 40)} wd=${searchParams.get('wd')?.slice(0, 20)}`);

  const drpysParams = new URLSearchParams();
  for (const [key, value] of Array.from(searchParams.entries())) {
    if (key !== 'module') {
      // 详情时：如果 ids 是 base64url 编码的 URL，解码回原文
      if (isDetail && key === 'ids' && /^[\w-]{20,}$/.test(value) && !value.startsWith('http')) {
        try {
          const decoded = decodeVodId(value);
          drpysParams.set(key, decoded);
        } catch {
          drpysParams.set(key, value); // 解码失败则原样传递
        }
      } else {
        drpysParams.set(key, value);
      }
    }
  }
  drpysParams.set('pwd', DRPYS_PWD);

  const targetUrl = `${DRPYS_BASE}/api/${encodeURIComponent(moduleName)}?${drpysParams.toString()}`;

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `drpyS 请求失败: ${response.status}` },
        { status: response.status }
      );
    }

    const data = await response.json();

    log(`drpyS 返回, 数据包含 list: ${Array.isArray(data?.list)} list.length=${data?.list?.length}`);

    const isSearch = searchParams.has('wd');

    // ---- 搜索响应: 补 vod_play_url 占位, 并将 URL 型 vod_id 编码 ----
    if (isSearch && data && data.list && Array.isArray(data.list)) {
      for (const item of data.list) {
        if (!item.vod_play_url) {
          item.vod_play_url = '播放$/api/drpys/play?placeholder=1';
        }
        // 将 URL 格式的 vod_id 编码为 base64url, 透传 detail 路由 ID 校验
        if (item.vod_id && typeof item.vod_id === 'string' && (item.vod_id.startsWith('http://') || item.vod_id.startsWith('https://'))) {
          item.vod_id = encodeVodId(item.vod_id);
        }
      }
    }

    // ---- 详情响应: 改写网盘播放链接, 并解码 vod_id ----
    if (isDetail && data && data.list && Array.isArray(data.list)) {
      for (const item of data.list) {
        if (item.vod_play_url && item.vod_play_from) {
          const sourceBlocks = item.vod_play_url.split('$$$');
          const sourceFlags = item.vod_play_from.split('$$$');
          const { newUrl, newFlags } = rewritePlayUrl(sourceBlocks, sourceFlags, mod);
          item.vod_play_url = newUrl;
          item.vod_play_from = newFlags;
          log(`详情改写: ${item.vod_name} 源${sourceFlags.length}个, play_url=${item.vod_play_url?.slice(0, 80)}`);
        }
      }
    }

    return NextResponse.json(data);
  } catch (error: any) {
    log(`异常: ${error.message}`);
    return NextResponse.json(
      { error: `drpyS 代理错误: ${error.message || '未知错误'}` },
      { status: 502 }
    );
  }
}