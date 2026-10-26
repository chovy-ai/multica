export const zhCNSettingsPanel = {
  title: "设置",
  nav: {
    general: "通用",
    developer: "开发者",
    diagnostics: "诊断信息",
    agent: "Agent",
    experimental: "实验性",
    sectionsLabel: "设置分区"
  },
  workspace: {
    navSubtitle: "当前房间设置",
    navBasic: "基础",
    spaceNameLabel: "房间名称",
    dangerLabel: "房间",
    deleteAction: "删除房间",
    deleteHelp: "为所有成员删除这个房间",
    leaveAction: "退出房间",
    leaveHelp: "在这台设备上退出这个房间",
    agentTitle: "Agent",
    defaultAgentHelp: "这个房间默认使用的已启用 Agent",
    noEnabledAgents: "暂无已启用 Agent",
    noEnabledAgentsHelp: "请先在管理 Agent 中启用一个 Agent",
    agentNotInstalledBadge: "暂未安装",
    permissionLabel: "权限",
    permissionPreset: "默认权限",
    permissionAutoReview: "替我审批",
    permissionFullAccess: "完全访问权限",
    personalizationTitle: "个性化"
  },
  general: {
    title: "通用",
    languageLabel: "界面语言",
    uiThemeLabel: "外观",
    wallpaperLabel: "壁纸",
    sshAgentForwardingTitle: "转发 SSH agent",
    sshAgentForwardingDescription:
      "允许路由到沙箱的命令通过本机 ssh-agent 用你的 SSH 私钥签名。密钥本身不会离开 Mac，但开启期间沙箱里运行的任何代码都能用它来签名。",
    uiTheme: {
      system: "跟随系统（自动）",
      light: "浅色",
      dark: "深色"
    },
    logs: {
      title: "诊断信息",
      sizeLabel: "日志大小",
      sizeValue: "{{count}} 个文件（{{size}}）",
      summaryError: "无法加载诊断日志大小",
      actionsLabel: "操作",
      export: "导出诊断信息",
      exporting: "正在导出…",
      clear: "清空日志",
      clearing: "正在清空…",
      cleared: "已清空 {{count}} 个诊断文件（{{size}}）",
      saved: "已将 {{count}} 个诊断文件保存到 {{path}}",
      copyAgentPrompt: "复制给 Agent 的调试指令",
      copiedAgentPrompt: "已复制给 Agent 的调试指令",
      error: "无法导出诊断信息，请重试",
      clearError: "无法清空诊断日志，请重试"
    }
  },
  agent: {
    title: "Agent",
    defaultAgentLabel: "默认 Agent",
    defaultAgentHelp: "新任务和终端默认使用的 AI 提供方",
    moveUp: "上移",
    moveDown: "下移",
    fullAccessLabel: "完全访问模式",
    fullAccessHelp: "为 Agent 关闭沙箱和人工审批"
  },
  developer: {
    title: "开发者",
    versionLabel: "软件版本",
    agentPresentationTitle: "Agent 形态",
    agentPresentationTerminal: "终端形态",
    agentPresentationGui: "GUI 形态",
    experimentalTitle: "试验功能",
    installDoctorTitle: "Install Doctor",
    installDoctorDescription:
      "将 tsh 安装到终端，用于运行 runtime status 和 reset 命令。",
    installDoctorInstall: "Install Doctor",
    installDoctorRepair: "修复 Doctor",
    installDoctorInstalling: "正在安装…",
    installDoctorInstalledButton: "已安装",
    installDoctorInstalled: "已安装到 {{path}}",
    installDoctorError: "无法安装 Doctor CLI，请重试。",
    agentGUIBatchRunnerTitle: "Agent GUI 批量执行器",
    agentGUIBatchRunnerDescription:
      "通过 Agent GUI session 执行 prompt JSONL 用例，并导出批次结果。"
  },
  experimental: {
    title: "实验性"
  }
};
