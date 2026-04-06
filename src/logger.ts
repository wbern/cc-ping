interface LoggerOptions {
  quiet: boolean;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
}

interface Logger {
  log: (msg: string) => void;
  error: (msg: string) => void;
}

export function createLogger(options: LoggerOptions): Logger {
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;

  return {
    log: (msg: string) => {
      if (!options.quiet) {
        stdout(msg);
      }
    },
    error: (msg: string) => {
      stderr(msg);
    },
  };
}
