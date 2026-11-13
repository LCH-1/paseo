import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * Reuses Settings Sync's Claude CredMan format, including split credentials; read-only. A snapshot
 * reads a login's metadata, its unsplit record, the chunks the metadata names and the metadata
 * again, all in one process, so a login rewritten while it is read is still detected. Lines are
 * written by hand: Windows PowerShell 5.1 turns an array inside ConvertTo-Json into an object.
 */
export const snapshotScript = String.raw`$ErrorActionPreference='Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class PaseoProviderCredentials {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Credential { public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
 [DllImport("advapi32.dll",EntryPoint="CredReadW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ReadNative(string target,UInt32 type,UInt32 flags,out IntPtr value);
 [DllImport("advapi32.dll")] static extern void CredFree(IntPtr value);
 public static object Read(string target) { IntPtr pointer; if(!ReadNative(target,1,0,out pointer)) { if(Marshal.GetLastWin32Error()==1168)return null; throw new Win32Exception(); } try { var credential=(Credential)Marshal.PtrToStructure(pointer,typeof(Credential)); if(credential.CredentialBlobSize>1048576)throw new Exception(); var bytes=new byte[credential.CredentialBlobSize]; Marshal.Copy(credential.CredentialBlob,bytes,0,bytes.Length); long stamp=((long)(uint)credential.LastWritten.dwHighDateTime<<32)|(uint)credential.LastWritten.dwLowDateTime; return new {value=Convert.ToBase64String(bytes),updatedAt=(DateTime.FromFileTimeUtc(stamp)-new DateTime(1970,1,1)).TotalMilliseconds}; } finally { CredFree(pointer); } }
}
'@
function Stored($credential) { if($null -eq $credential){'null'}else{'"'+$credential.value+'"'} }
$request=[Console]::In.ReadToEnd()|ConvertFrom-Json
switch($request.operation) {
 'snapshot' { foreach($name in $request.names){
  $meta=[PaseoProviderCredentials]::Read($name+'#m')
  $raw=[PaseoProviderCredentials]::Read($name)
  $parts='null'; $after='null'
  if($null -ne $meta){
   $count=0
   try { $count=[int](([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($meta.value))|ConvertFrom-Json).n) } catch { $count=0 }
   if($count -ge 1 -and $count -le 256){
    $chunks=for($index=0;$index -lt $count;$index++){ Stored ([PaseoProviderCredentials]::Read($name+'#'+$index)) }
    $parts='['+($chunks -join ',')+']'
    $after=Stored ([PaseoProviderCredentials]::Read($name+'#m'))
   }
  }
  [Console]::Out.WriteLine('{"meta":'+(Stored $meta)+',"raw":'+(Stored $raw)+',"parts":'+$parts+',"after":'+$after+'}')
 } }
 default { throw 'operation' }
}
} catch { [Console]::Error.Write('Provider credential store failed.'); exit 1 }`;

/**
 * What one login name held while it was read: its split metadata, its unsplit record, the chunks
 * that metadata names (null when it names none), and the metadata read again after them.
 */
export interface StoredSnapshot {
  meta: string | null;
  raw: string | null;
  parts: Array<string | null> | null;
  after: string | null;
}

/** Reads the names in order and answers one snapshot per name. */
export type ReadSnapshots = (names: string[]) => Promise<StoredSnapshot[]>;

/** Runs a helper script; `snapshotScript` unless a test stands in for the credential store. */
export function snapshotReader(script: string = snapshotScript): ReadSnapshots {
  return (names) => runSnapshotScript(script, names);
}

// Every call starts PowerShell and compiles the helper type, so a caller asks for every login it
// needs at once.
export const readSnapshots: ReadSnapshots = snapshotReader();

function runSnapshotScript(script: string, names: string[]): Promise<StoredSnapshot[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      join(
        process.env.SystemRoot ?? "C:/Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, stdio: "pipe" },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!ok) {
        child.kill();
        reject(new Error("Claude Windows credential store could not be read"));
        return;
      }
      let snapshots: StoredSnapshot[];
      try {
        const lines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/).filter(Boolean);
        if (lines.length !== names.length) throw new Error("Unexpected credential count");
        snapshots = lines.map((line) => {
          const read = JSON.parse(line);
          if (read.parts !== null && !Array.isArray(read.parts))
            throw new Error("Unexpected credential chunks");
          return {
            meta: storedValue(read.meta),
            raw: storedValue(read.raw),
            parts: read.parts === null ? null : read.parts.map(storedValue),
            after: storedValue(read.after),
          };
        });
      } catch {
        reject(new Error("Invalid Claude Windows credential store response"));
        return;
      }
      resolve(snapshots);
    };
    const timer = setTimeout(() => finish(false), 20_000);
    // A split login is at most 256 chunks of a 1 MiB record, so the cap grows with the names.
    const limit = 2_097_152 * Math.max(1, names.length);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) finish(false);
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.on("error", () => finish(false));
    child.stdin.end(JSON.stringify({ operation: "snapshot", names }));
  });
}

/** A stored blob as the helper prints it: base64, or null when there is none. */
function storedValue(stored: unknown): string | null {
  if (stored === null) return null;
  if (typeof stored !== "string") throw new Error("Unexpected credential value");
  return Buffer.from(stored, "base64").toString("utf8");
}

/** The record a snapshot holds, or an error saying why it cannot be trusted. */
function fromSnapshot({ meta, raw, parts, after }: StoredSnapshot): unknown | null {
  if (!meta) return raw === null ? null : JSON.parse(raw);
  const info = JSON.parse(meta);
  if (
    !info ||
    typeof info !== "object" ||
    !Number.isInteger(info.n) ||
    info.n < 1 ||
    info.n > 256 ||
    !Number.isInteger(info.l) ||
    info.l < 1 ||
    info.l > info.n * 2400
  )
    throw new Error("Invalid split Claude Windows credential metadata");
  const chunks = parts?.length === info.n ? parts : null;
  const encoded = chunks?.map((chunk) => chunk ?? "").join("") ?? "";
  if (!chunks || chunks.some((chunk) => chunk === null) || encoded.length !== info.l)
    throw new Error("Incomplete split Claude Windows credentials");
  // The metadata is read again after the chunks so a login rewritten in between is detected.
  if (after !== meta) throw new Error("Changed split Claude Windows credentials");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

function isChanging(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    (error instanceof Error &&
      /^(?:Invalid split|Incomplete split|Changed split)/.test(error.message))
  );
}

/**
 * Reads several services' logins in one helper process and answers one value per service, in
 * order. A service whose split login was being rewritten is read again on its own, at most twice;
 * a read that fails fails only its own service, or every service when the helper itself failed.
 */
export function readWindowsCredentialsMany(
  services: string[],
  read: ReadSnapshots = readSnapshots,
): Array<Promise<unknown | null>> {
  const settle = new Map<
    string,
    {
      result: Promise<unknown | null>;
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
    }
  >();
  for (const service of services) {
    if (settle.has(service)) continue;
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<unknown | null>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    // Callers own the outcome; one they never await must not surface as unhandled.
    result.catch(() => {});
    settle.set(service, { result, resolve, reject });
  }
  void (async () => {
    let pending = [...settle.keys()];
    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 75));
      let snapshots: StoredSnapshot[];
      try {
        snapshots = await read(pending.map((service) => service + "/claude-code-user"));
      } catch (error) {
        for (const service of pending) settle.get(service)!.reject(error);
        return;
      }
      const again: string[] = [];
      pending.forEach((service, index) => {
        try {
          const snapshot = snapshots[index];
          if (!snapshot) throw new Error("Missing Claude Windows credential snapshot");
          settle.get(service)!.resolve(fromSnapshot(snapshot));
        } catch (error) {
          if (isChanging(error) && attempt < 2) again.push(service);
          else settle.get(service)!.reject(error);
        }
      });
      pending = again;
    }
  })();
  return services.map((service) => settle.get(service)!.result);
}

export function readWindowsCredentials(
  service: string,
  read: ReadSnapshots = readSnapshots,
): Promise<unknown | null> {
  return readWindowsCredentialsMany([service], read)[0]!;
}
