export interface BrowserNodeWebviewTag extends HTMLElement {
  executeJavaScript?: <T = unknown>(
    code: string,
    userGesture?: boolean
  ) => Promise<T>;
  getWebContentsId?: () => number;
}
