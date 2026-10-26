export const enSettingsPanel = {
  title: "Settings",
  nav: {
    general: "General",
    developer: "Developer",
    diagnostics: "Diagnostics",
    agent: "Agent",
    experimental: "Experimental",
    sectionsLabel: "Settings sections"
  },
  workspace: {
    navSubtitle: "Current room settings",
    navBasic: "Basic",
    spaceNameLabel: "Room Name",
    dangerLabel: "Room",
    deleteAction: "Delete Room",
    deleteHelp: "Delete this room for everyone",
    leaveAction: "Leave Room",
    leaveHelp: "Leave this room on this device",
    agentTitle: "Agent",
    defaultAgentHelp: "The default enabled agent for this room",
    noEnabledAgents: "No enabled agents",
    noEnabledAgentsHelp:
      "Enable an agent from Manage Agents before choosing a default",
    agentNotInstalledBadge: "Not installed",
    permissionLabel: "Permissions",
    permissionPreset: "Default permission",
    permissionAutoReview: "Approve for me",
    permissionFullAccess: "Full Access",
    personalizationTitle: "Personalization"
  },
  general: {
    title: "General",
    languageLabel: "Display Language",
    uiThemeLabel: "Appearance",
    wallpaperLabel: "Wallpaper",
    sshAgentForwardingTitle: "Forward SSH agent",
    sshAgentForwardingDescription:
      "Lets routed sandbox commands sign with your local SSH keys via the host ssh-agent. Keys never leave your Mac, but any code that runs in the sandbox while this is on can use them.",
    uiTheme: {
      system: "System (Auto)",
      light: "Light",
      dark: "Dark"
    },
    logs: {
      title: "Diagnostics",
      sizeLabel: "Log Size",
      sizeValue: "{{count}} files ({{size}})",
      summaryError: "Unable to load diagnostics size",
      actionsLabel: "Actions",
      export: "Export Diagnostics",
      exporting: "Exporting…",
      clear: "Clear Logs",
      clearing: "Clearing…",
      cleared: "Cleared {{count}} diagnostic files ({{size}})",
      saved: "Saved {{count}} diagnostic files to {{path}}",
      copyAgentPrompt: "Copy Agent Debug Prompt",
      copiedAgentPrompt: "Copied debug instructions for the agent",
      error: "Unable to export diagnostics. Please try again",
      clearError: "Unable to clear diagnostics. Please try again"
    }
  },
  agent: {
    title: "Agent",
    defaultAgentLabel: "Default Agent",
    defaultAgentHelp: "The default AI provider for new tasks and terminals",
    moveUp: "Move up",
    moveDown: "Move down",
    fullAccessLabel: "Full Access Mode",
    fullAccessHelp: "Disable sandbox and manual approvals for agents"
  },
  developer: {
    title: "Developer",
    versionLabel: "Software Version",
    agentPresentationTitle: "Agent Presentation",
    agentPresentationTerminal: "Terminal",
    agentPresentationGui: "GUI",
    experimentalTitle: "Experimental Features",
    installDoctorTitle: "Install Doctor",
    installDoctorDescription:
      "Install tsh into Terminal for runtime status and reset commands.",
    installDoctorInstall: "Install Doctor",
    installDoctorRepair: "Repair Doctor",
    installDoctorInstalling: "Installing…",
    installDoctorInstalledButton: "Installed",
    installDoctorInstalled: "Installed at {{path}}",
    installDoctorError: "Unable to install Doctor CLI. Please try again.",
    agentGUIBatchRunnerTitle: "Agent GUI Batch Runner",
    agentGUIBatchRunnerDescription:
      "Run prompt JSONL cases through Agent GUI sessions and export the batch results."
  },
  experimental: {
    title: "Experimental"
  }
};
