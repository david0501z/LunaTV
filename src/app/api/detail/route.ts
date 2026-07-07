import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getAvailableApiSites, getCacheTime } from '@/lib/config';
import { getDetailFromApi } from '@/lib/downstream';

export const runtime = 'nodejs';

function log(...args: unknown[]) {
  console.log('[detail]', ...args);
}

/**
 * 从标准 vod_play_url 格式解析剧集 URL 和标题
 * 格式: "标题1$url1#标题2$url2"
 */
function parseEpisodesBlock(block: string): { episodes: string[]; titles: string[] } {
  const episodes: string[] = [];
  const titles: string[] = [];
  if (!block) return { episodes, titles };
  const parts = block.split('#');
  for (const part of parts) {
    const dollarIdx = part.indexOf('$');
    if (dollarIdx > 0 && dollarIdx < part.length - 1) {
      titles.push(part.substring(0, dollarIdx).trim());
      episodes.push(part.substring(dollarIdx + 1));
    } else if (part.length > 0) {
      titles.push('');
      episodes.push(part);
    }
  }
  return { episodes, titles };
}

/**
 * 处理 drpyS 详情响应:
 * 调用 drpys 路由（已含 rewritePlayUrl 转换），将多源 ($$$ 分隔) 拆成多个 SearchResult 条目
 */
async function handleDrpysDetail(drpysModule: string, ids: string, cookie: string) {
  // 通过 drpys 路由（走 rewritePlayUrl 转换）
  const drpysDetailUrl = `http://localhost:3000/api/drpys?module=${encodeURIComponent(drpysModule)}&ac=videolist&ids=${encodeURIComponent(ids)}`;

  log(`转发 drpys 详情路由: ${drpysDetailUrl.slice(0, 120)}`);

  const res = await fetch(drpysDetailUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: AbortSignal.timeout(25000),
  });

  if (!res.ok) {
    throw new Error(`drpyS 详情请求失败: ${res.status}`);
  }

  const data = await res.json();
  log(`drpyS 详情返回, list=${Array.isArray(data?.list) ? data.list.length : '?'}`);

  if (!data?.list || !Array.isArray(data.list) || data.list.length === 0) {
    return { list: [] };
  }

  const item = data.list[0];
  if (!item.vod_play_url || !item.vod_play_from) {
    // 没有多个源，直接原样返回
    return data;
  }

  const sourceBlocks = item.vod_play_url.split('$$$');
  const sourceNames = item.vod_play_from.split('$$$');

  // 解析 vod_content 里的文本（清理 HTML）
  const descText = (item.vod_content || '').replace(/<[^>]+>/g, '');

  const list: any[] = [];

  for (let si = 0; si < sourceBlocks.length && si < sourceNames.length; si++) {
    const flag = sourceNames[si];
    // 跳过 #1, #2 等后缀
    const cleanFlag = flag.includes('#') ? flag.split('#')[0] : flag;
    const { episodes, titles } = parseEpisodesBlock(sourceBlocks[si]);

    if (episodes.length === 0) continue;

    // 用 base64url(flag) 作为 id 后缀，使每个源有唯一 id
    const flagSuffix = Buffer.from(cleanFlag, 'utf-8').toString('base64url');
    const uniqueId = `${ids}::${flagSuffix}`;

    log(`  源[${si}]: ${cleanFlag}, ${episodes.length}集, id后缀=${flagSuffix}`);

    list.push({
      id: uniqueId,
      title: (item.vod_name || '').trim(),
      poster: item.vod_pic || '',
      episodes,
      episodes_titles: titles,
      source: drpysModule,
      source_name: cleanFlag,
      year: item.vod_year ? (item.vod_year.match(/\d{4}/)?.[0] || '') : 'unknown',
      desc: descText,
      type_name: item.type_name || '',
      douban_id: item.vod_douban_id || 0,
      class: item.vod_class || '',
    });
  }

  // 如果没能拆出任何源，回退原数据
  if (list.length === 0) {
    return data;
  }

  return { list };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const sourceCode = searchParams.get('source');

  log(`请求: id=${id?.slice(0, 50)} source=${sourceCode}`);

  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    log('未授权');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!id || !sourceCode) {
    log('缺少必要参数');
    return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
  }

  // ---- drpyS 源 ----
  if (sourceCode.startsWith('drpys-')) {
    try {
      const result = await handleDrpysDetail(sourceCode, id, request.headers.get('cookie') || '');
      const cacheTime = await getCacheTime();
      log(`drpyS 详情成功: ${sourceCode} ids=${id?.slice(0, 50)} 源数=${result?.list?.length}`);
      return NextResponse.json(result, {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
          'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Netlify-Vary': 'query',
        },
      });
    } catch (error) {
      log(`drpyS 详情异常: ${(error as Error).message}`);
      return NextResponse.json(
        { error: `drpyS 详情错误: ${(error as Error).message}` },
        { status: 502 }
      );
    }
  }

  // ---- 标准 API 源 ----
  try {
    const apiSites = await getAvailableApiSites(authInfo.username);
    const apiSite = apiSites.find((site) => site.key === sourceCode);

    if (!apiSite) {
      log(`无效API来源: ${sourceCode}`);
      return NextResponse.json({ error: '无效的API来源' }, { status: 400 });
    }

    log(`调用 getDetailFromApi: site=${apiSite.key} id=${id?.slice(0, 50)}`);
    const result = await getDetailFromApi(apiSite, id);
    const cacheTime = await getCacheTime();

    log(`成功: source=${sourceCode} id=${id?.slice(0, 50)} vod_play_url=${(result as any)?.list?.[0]?.vod_play_url?.slice(0, 60)}`);

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
        'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
        'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
        'Netlify-Vary': 'query',
      },
    });
  } catch (error) {
    log(`异常: ${(error as Error).message}`);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}