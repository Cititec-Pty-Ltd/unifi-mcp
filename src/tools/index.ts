import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { SITE_TOOLS, handleSiteTool, isSiteTool } from './sites.js';
import { HOST_TOOLS, handleHostTool, isHostTool } from './hosts.js';
import { DEVICE_TOOLS, handleDeviceTool, isDeviceTool } from './devices.js';
import { ISP_METRICS_TOOLS, handleIspMetricsTool, isIspMetricsTool } from './isp-metrics.js';
import { SDWAN_TOOLS, handleSdWanTool, isSdWanTool } from './sdwan.js';
import { NETWORK_TOOLS, handleNetworkTool, isNetworkTool } from './network.js';
import type { CallToolResult } from './types.js';

export const ALL_TOOLS: Tool[] = [
  ...SITE_TOOLS,
  ...HOST_TOOLS,
  ...DEVICE_TOOLS,
  ...ISP_METRICS_TOOLS,
  ...SDWAN_TOOLS,
  ...NETWORK_TOOLS,
];

export async function dispatchToolCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  if (isSiteTool(name)) return handleSiteTool(name, args);
  if (isHostTool(name)) return handleHostTool(name, args);
  if (isDeviceTool(name)) return handleDeviceTool(name, args);
  if (isIspMetricsTool(name)) return handleIspMetricsTool(name, args);
  if (isSdWanTool(name)) return handleSdWanTool(name, args);
  if (isNetworkTool(name)) return handleNetworkTool(name, args);
  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
}
