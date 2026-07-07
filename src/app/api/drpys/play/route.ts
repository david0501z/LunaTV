/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const DRPYS_BASE = process.env.DRPYS_BASE_URL || 'http://172.17.0.1:5757';
// drpyS 密码优先读取环境变量 DRPYS_PWD，yml 中可单独配置
const DRPYS_PWD = process.env.DRPYS_PWD || 'admin123';

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

function log(...args: any[]) {
  console.log('[drpys/play]', ...args);
}

/** 需要透传的关键响应头 */
const PASSTHROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
  'expires',
  'last-modified',
  'etag',
];

/**
 * 剥离 #fragment 后缀（spider 用来传 metadata，不是 URL 的一部分）
 */
function stripFragment(url: string): string {
  const hashIdx = url.indexOf('#');
  return hashIdx > 0 ? url.substring(0, hashIdx) : url;
}

/**
 * 代理请求视频流，透传 Range 头支持分段播放
 */
async function proxyVideo(videoUrl: string, request: NextRequest, header: any): Promise<NextResponse> {
  const cleanUrl = stripFragment(videoUrl);

  // 替换内部地址
  const finalUrl = cleanUrl.replace('http://127.0.0.1:5757', DRPYS_BASE);

  if (finalUrl.includes('undefined') || finalUrl.includes('null')) {
    log(`跳过无效 URL: ${finalUrl.slice(0, 80)}`);
    return null as any;
  }

  if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
    return null as any;
  }

  log(`代理请求: ${finalUrl.slice(0, 80)}`);

  const upstreamHeaders: Record<string, string> = {
    'User-Agent': header?.['User-Agent'] || 'Mozilla/5.0',
  };
  const clientRange = request.headers.get('range');
  if (clientRange) {
    upstreamHeaders['Range'] = clientRange;
    log(`转发 Range: ${clientRange}`);
  }
  if (header?.['Cookie']) {
    upstreamHeaders['Cookie'] = header['Cookie'];
  }

  try {
    const proxyRes = await fetch(finalUrl, {
      headers: upstreamHeaders,
      signal: AbortSignal.timeout(30000),
    });

    const responseHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
    };
    for (const h of PASSTHROUGH_HEADERS) {
      const val = proxyRes.headers.get(h);
      if (val) responseHeaders[h] = val;
    }

    log(`代理结果: ${proxyRes.status} type=${responseHeaders['content-type']} len=${responseHeaders['content-length'] || '?'}`);
    return new NextResponse(proxyRes.body, {
      status: proxyRes.status,
      headers: responseHeaders,
    });
  } catch (proxyErr: any) {
    log(`代理请求异常: ${proxyErr.message}`);
    return null as any;
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const mod = searchParams.get('module');
  const flag = searchParams.get('flag');
  const ids = searchParams.get('ids');

  log(`请求: module=${mod} flag=${flag} ids=${ids?.slice(0, 60)}...`);

  if (!mod || !flag || !ids) {
    log('参数不完整');
    return NextResponse.json({ error: '缺少必要参数: module, flag, ids' }, { status: 400 });
  }

  const moduleFile = DRPYS_MODULES[mod] || mod;
  const drpysPlayUrl = `${DRPYS_BASE}/api/${encodeURIComponent(moduleFile)}?pwd=${DRPYS_PWD}&flag=${encodeURIComponent(flag)}&play=${encodeURIComponent(ids)}`;

  log(`请求 drpyS: ${drpysPlayUrl}`);

  try {
    const res = await fetch(drpysPlayUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (!res.ok) {
      log(`drpyS 返回 ${res.status}`);
      return NextResponse.json({ error: `drpyS play 请求失败: ${res.status}` }, { status: 502 });
    }

    const data = await res.json();
    log(`drpyS 返回: parse=${data.parse}, jx=${data.jx}, url 数组长度=${data.url?.length}`);

    // ---- 处理 jx=1 模式: 重试一次, 期望拿到真实 URL ----
    if (data.parse === 1 && data.jx === 1) {
      log('jx=1, 重试一次');
      const retryRes = await fetch(drpysPlayUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(30000),
      });
      if (retryRes.ok) {
        const retryData = await retryRes.json();
        log(`重试结果: parse=${retryData.parse}, url=${typeof retryData.url === 'string' ? retryData.url.slice(0, 100) : `长度=${retryData.url?.length}`}`);
        // 把结果塞回 data, 继续走 parse=0 逻辑
        if (retryData.parse === 0 && Array.isArray(retryData.url)) {
          data.url = retryData.url;
          data.header = retryData.header || data.header;
        } else if (retryData.url && typeof retryData.url === 'string' && retryData.url.startsWith('http')) {
          const result = await proxyVideo(retryData.url, request, retryData.header || data.header);
          if (result) return result;
        }
      }
    }

    // ---- parse=0 模式: [name1, url1, name2, url2, ...] ----
    if (data.parse === 0 && Array.isArray(data.url) && data.url.length >= 2) {
      for (let i = 1; i < data.url.length; i += 2) {
        const rawUrl = data.url[i];
        log(`url[${i}]: ${rawUrl?.slice(0, 100)}`);

        if (typeof rawUrl === 'string') {
          // 跳过 Go 代理 URL（客户端专属）
          if (rawUrl.includes('127.0.0.1:7777')) {
            log(`跳过 Go 代理 URL: ${rawUrl.slice(0, 80)}`);
            continue;
          }

          const result = await proxyVideo(rawUrl, request, data.header);
          if (result) return result;
        }
      }
    }

    log('所有 URL 均无效');
    return NextResponse.json({
      error: '无法解析播放地址',
      detail: 'drpyS 返回了无效的播放地址，可能是网盘解析失败（cookie 过期或文件不存在）',
      debug: { parse: data.parse, urlCount: data.url?.length },
    }, { status: 502 });
  } catch (error: any) {
    log(`异常: ${error.message}`);
    return NextResponse.json(
      { error: `drpyS play 错误: ${error.message || '未知错误'}` },
      { status: 502 }
    );
  }
}