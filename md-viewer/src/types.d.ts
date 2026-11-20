interface DocumentData { id: string; path: string; text: string; version: string; error?: string }
interface DocumentResult { document?: DocumentData; error?: string }
interface ViewerSettings { theme: 'light' | 'dark'; fontSize: number; toc: boolean }
interface Window {
  viewer: {
    initial(): Promise<{ settings: ViewerSettings; documents: DocumentData[] }>;
    pickFiles(): Promise<void>;
    dropFiles(files: File[]): Promise<void>;
    closeDocument(id: string): Promise<boolean>;
    draft(id: string, draft: { text: string; version: string } | null): Promise<void>;
    saveDocument(id: string, draft: { text: string; version: string }): Promise<DocumentResult>;
    reloadDocument(id: string): Promise<DocumentResult | undefined>;
    onSaved(cb: (doc: DocumentData) => void): () => void;
    onSaveError(cb: (message: string) => void): void;
    saveSettings(settings: ViewerSettings): Promise<void>;
    link(id: string, href: string): Promise<{ error?: string; hash?: string }>;
    onOpen(cb: (doc: DocumentData) => void): () => void;
    onUpdate(cb: (doc: DocumentData) => void): () => void;
  }
}
declare module 'markdown-it-task-lists';
