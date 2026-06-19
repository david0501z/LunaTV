/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * drpyS 代理路由
 * 
 * 将 LunaTV 的苹果 CMS V10 API 请求转发到 drpyS T4 接口
 * 
 * 请求格式: /api/drpys?ac=videolist&wd=keyword (与标准 CMS 格式一致)
 * drpyS 地址: http://david525:5757/api/{源名称}?wd=keyword&pwd=默认密码
 */
const DRPYS_BASE = process.env.DRPYS_BASE_URL || 'http://172.17.0.1:5757';
const DRPYS_PWD = process.env.DRPYS_PWD || 'dzyyds';

// drpyS 源模块映射: 配置中的 key → drpyS 模块文件名
// 这些是从 drpyS spider/js 目录中常见的网盘源
const DRPYS_MODULES: Record<string, string> = {
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

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const module = searchParams.get('module');

  if (!module) {
    // 返回可用的模块列表
    return NextResponse.json({ modules: DRPYS_MODULES });
  }

  // 构建 drpyS 请求 URL
  // 复制除 module 外的所有参数
  const drpysParams = new URLSearchParams();
  for (const [key, value] of searchParams.entries()) {
    if (key !== 'module') {
      drpysParams.set(key, value);
    }
  }
  // drpyS 的 ac 参数映射:
  // LunaTV 用 ac=videolist 做搜索和详情，drpyS 用 wd/ids 做判断
  // 直接透传即可，drpyS 会根据 wd/ids/play 等参数自动判断
  // 添加密码
  drpysParams.set('pwd', DRPYS_PWD);

  const moduleName = DRPYS_MODULES[module] || module;
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
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json(
      { error: `drpyS 代理错误: ${error.message || '未知错误'}` },
      { status: 502 }
    );
  }
}
