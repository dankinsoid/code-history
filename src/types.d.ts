declare module 'vscode' {
  interface WebviewPanel {
    webview: {
      html: string;
      onDidReceiveMessage: (callback: (message: any) => void) => void;
      postMessage: (message: any) => void;
    };
  }
}
