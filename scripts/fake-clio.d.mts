export interface FakeClioFailure {
  match: string | RegExp;
  status: number;
  times?: number;
  storage?: boolean;
  headers?: Record<string, string>;
}

export interface FakeClioOptions {
  matterCount?: number;
  unfiledDocs?: number;
  lightDocs?: boolean;
  failures?: FakeClioFailure[];
  forbidden?: string[];
  rejectFields?: string[];
  omitRecords?: boolean;
  downloadDelayMs?: number;
  onRequest?: (record: { method?: string; path: string; query: string; hasAuthorization: boolean }, stats: any) => void;
}

export interface FakeClio {
  apiBase: string;
  state: any;
  stats: {
    requests: { method?: string; path: string; query: string; hasAuthorization: boolean }[];
    storage: { path?: string; hasAuthorization: boolean }[];
    nonGet: number;
    maxConcurrentDownloads: number;
    downloadsStarted: number;
  };
  stop(): Promise<void>;
}

export function startFakeClio(options?: FakeClioOptions): Promise<FakeClio>;
