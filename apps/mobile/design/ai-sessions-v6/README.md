# iOS AI Sessions interaction reference

These imagegen boards record the approved interaction direction. They are design
mockups, not screenshots or evidence of native device testing. Example models,
percentages, times and device names are illustrative; the app reads real values
from the selected computer.

| Board | Flow |
| --- | --- |
| [01](01-launch-login-workspace.webp) | Launch, email sign-in and workspace selection |
| [02](02-ai-sessions-tab-chat-more.webp) | AI Sessions in the third tab; workspace Chat under More |
| [03](03-ai-session-list-and-conversation.webp) | Computer sessions, new conversation and transcript |
| [04](04-keyboard-execution-offline-workspace.webp) | Keyboard, execution, disconnection and workspace switching |
| [05](05-message-queue.webp) | Add follow-ups; pause, remove or send immediately |
| [06](06-projects-and-history.webp) | Collapsible folder groups and older history |
| [07](07-model-and-execution-settings.webp) | Model, supported reasoning effort and execution permissions |
| [08](08-attachments-preview-and-share.webp) | File cards, native document preview and sharing |
| [09](09-side-workspace.webp) | Full-screen files, public webpages and quoted Side conversations |
| [10](10-provider-usage.webp) | Usage and limits inside the conversation's existing More menu |

The mobile implementation uses existing React Native controls, native iOS action
menus and Expo Router sheets. It preserves the approved navigation and behavior;
its native layout has not yet been compared on a simulator or iPhone. In
particular, sending a queued message immediately interrupts the current generation
without a second confirmation, and account limits have no persistent composer bar.

Desktop browser automation and computer-local service preview are not implemented
on iOS. Building and device verification require full Xcode and an iPhone SDK;
the TypeScript, unit and Go tests do not replace that verification.
