import * as vscode from 'vscode'

export type CodeHistoryItem = {
  date: string;
  message: string;
  content: string;
  timestamp: number;
  hash: string;
  author: string;
  range: vscode.Range;
};

export type CodeHistoryCompletion = {
  label: string;
  description: string;
  detail: string;
  documentation: vscode.MarkdownString;
  insertText: string;
  range: vscode.Range;
  filterText: string;
  sortText: string;
}