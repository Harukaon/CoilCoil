import { Search, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type { McpConfigurationSnapshot } from "@coilcoil/runtime-protocol";
import { McpDiscoveryDialog } from "../settings/McpDiscoveryDialog";
import { SkillSettings } from "../settings/SkillSettings";

export function OnboardingIntegrationsSetup({ runtimeId, cwd }: { runtimeId?: string; cwd?: string }): React.JSX.Element {
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [mcp, setMcp] = useState<McpConfigurationSnapshot>();

  useEffect(() => {
    let cancelled = false;
    void window.coilcoil.request<McpConfigurationSnapshot>({ type: "get_mcp_configuration", cwd }, runtimeId)
      .then((snapshot) => { if (!cancelled) setMcp(snapshot); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [cwd, runtimeId]);

  return (
    <div className="onboarding-integrations">
      <section className="onboarding-config-section onboarding-mcp-summary">
        <header><strong>MCP</strong><small>扫描本机常见客户端的 MCP 配置，选择后复制到 CoilCoil 管理。</small></header>
        <button className="onboarding-inline-action" type="button" onClick={() => setDiscoveryOpen(true)}><Search size={13} />扫描系统 MCP</button>
        {mcp ? <span className="onboarding-integrations-note">当前 Pi / CoilCoil 配置中已有 {mcp.servers.length} 个 MCP 服务。</span> : null}
      </section>
      <section className="onboarding-config-section onboarding-skills-embed">
        <header><strong><Sparkles size={14} />Skill</strong><small>自动扫描约定目录，也可以导入一个技能目录。</small></header>
        <SkillSettings runtimeId={runtimeId} cwd={cwd} />
      </section>
      <McpDiscoveryDialog
        open={discoveryOpen}
        cwd={cwd}
        runtimeId={runtimeId}
        onClose={() => setDiscoveryOpen(false)}
        onImported={(snapshot) => setMcp(snapshot)}
      />
    </div>
  );
}
