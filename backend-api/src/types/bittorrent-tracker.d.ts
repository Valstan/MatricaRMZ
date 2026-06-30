declare module 'bittorrent-tracker' {
  export class Server {
    constructor(opts?: any);
    listen(port?: number, hostname?: string, cb?: () => void): void;
    close(cb?: () => void): void;
    on(event: string, listener: (...args: any[]) => void): void;
  }
}
