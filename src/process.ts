import { execFile } from "child_process";

export function run(
  file: string,
  args: string[],
  timeout = 10_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr?.trim() || error.message));
        else resolve(stdout);
      },
    );
  });
}
