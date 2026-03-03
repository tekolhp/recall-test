declare module "node-media-server" {
  interface NodeMediaServerConfig {
    rtmp?: {
      port?: number;
      chunk_size?: number;
      gop_cache?: boolean;
      ping?: number;
      ping_timeout?: number;
    };
    http?: {
      port?: number;
      mediaroot?: string;
      allow_origin?: string;
    };
    trans?: {
      ffmpeg?: string;
      tasks?: Array<{
        app?: string;
        hls?: number;
        hlsFlags?: string;
        mp4?: number;
        mp4Flags?: string;
      }>;
    };
  }

  class NodeMediaServer {
    constructor(config: NodeMediaServerConfig);
    run(): void;
    stop(): void;
    on(event: string, callback: (...args: any[]) => void): void;
  }

  export = NodeMediaServer;
}
