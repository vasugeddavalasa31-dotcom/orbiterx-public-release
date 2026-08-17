export {};

declare global {
  interface Window {
    orbiterx: {
      onEvent(callback: (event: unknown) => void): () => void;
      pickDirectory(): Promise<string | undefined>;
      request(method: string, params: unknown): Promise<unknown>;
    };
  }
}
