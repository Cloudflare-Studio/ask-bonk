interface BunSubprocess {
  pid: number;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill: (signal?: NodeJS.Signals | number) => void;
}

declare const Bun: {
  spawn(command: string[], options: {
    detached?: boolean;
    env?: NodeJS.ProcessEnv;
    stdout: "pipe" | "ignore";
    stderr: "pipe" | "ignore";
  }): BunSubprocess;
};
