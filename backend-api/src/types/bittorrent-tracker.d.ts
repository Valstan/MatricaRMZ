declare module 'bittorrent-tracker' {
  /**
   * Адрес бинда: либо один на все протоколы, либо по протоколу отдельно. Второе нужно потому, что
   * udp6-сокет нельзя забиндить на IPv4-литерал — `dgram` отвечает `EINVAL`, а не `EADDRNOTAVAIL`.
   */
  type ListenHostname = string | { http?: string; udp?: string; udp6?: string };

  export class Server {
    constructor(opts?: any);
    listen(port?: number, hostname?: ListenHostname, cb?: () => void): void;
    close(cb?: () => void): void;
    on(event: string, listener: (...args: any[]) => void): void;
  }
}
