// Windows-only helper. Run by CoilCoil after the user explicitly confirms importing
// a Chrome/Edge profile. A short-lived SYSTEM task opens the system-bound DPAPI
// wrapper; Chrome's additional CNG wrapper is also opened there. Plaintext
// source keys never touch disk. No browser process or browser data is modified.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

internal static class BrowserImportKeyHelper
{
    private static string BrowserRoot(string browser, string localAppData)
    {
        if (browser == "chrome") return Path.Combine(localAppData, "Google", "Chrome", "User Data");
        if (browser == "edge") return Path.Combine(localAppData, "Microsoft", "Edge", "User Data");
        throw new InvalidOperationException("Unsupported browser.");
    }

    private static byte[] StateKey(string browser, string localAppData, string field, string prefix)
    {
        string file = Path.Combine(BrowserRoot(browser, localAppData), "Local State");
        string json = File.ReadAllText(file);
        Match match = Regex.Match(json, "\\\"" + field + "\\\"\\s*:\\s*\\\"([A-Za-z0-9+/=]+)\\\"");
        if (!match.Success) return null;
        byte[] value = Convert.FromBase64String(match.Groups[1].Value);
        byte[] marker = Encoding.ASCII.GetBytes(prefix);
        if (value.Length <= marker.Length) throw new InvalidOperationException("Invalid browser key.");
        for (int i = 0; i < marker.Length; i++)
            if (value[i] != marker[i]) throw new InvalidOperationException("Invalid browser key header.");
        byte[] encrypted = new byte[value.Length - marker.Length];
        Buffer.BlockCopy(value, marker.Length, encrypted, 0, encrypted.Length);
        Array.Clear(value, 0, value.Length);
        return encrypted;
    }

    private static string Quote(string text) { return "\"" + text.Replace("\"", "\\\"") + "\""; }

    private static void RunTaskCommand(string args)
    {
        using (Process process = Process.Start(new ProcessStartInfo("schtasks.exe", args)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        }))
        {
            string output = process.StandardOutput.ReadToEnd();
            string error = process.StandardError.ReadToEnd();
            if (!process.WaitForExit(10000) || process.ExitCode != 0)
                throw new InvalidOperationException("Windows could not run the temporary import task (" + process.ExitCode + "). " + (error.Length > 0 ? error : output));
        }
    }

    private static void RunSystem(string browser, string localAppData, string result)
    {
        if (WindowsIdentity.GetCurrent().User.Value != "S-1-5-18") throw new UnauthorizedAccessException("SYSTEM is required.");
        byte[] encrypted = StateKey(browser, localAppData, "app_bound_encrypted_key", "APPB");
        if (encrypted == null) throw new InvalidOperationException("No App-Bound key exists in the browser profile.");
        try
        {
            byte[] userProtected = ProtectedData.Unprotect(encrypted, null, DataProtectionScope.CurrentUser);
            // The result is still encrypted for the user's own DPAPI context.
            // It contains no plaintext cookie key and is deleted by --elevated.
            File.WriteAllBytes(result, userProtected);
            Array.Clear(userProtected, 0, userProtected.Length);
        }
        finally { Array.Clear(encrypted, 0, encrypted.Length); }
    }

    [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
    private static extern int NCryptOpenStorageProvider(out IntPtr provider, string name, int flags);
    [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
    private static extern int NCryptOpenKey(IntPtr provider, out IntPtr key, string name, int legacy, int flags);
    [DllImport("ncrypt.dll")]
    private static extern int NCryptDecrypt(IntPtr key, byte[] input, int inputLength, IntPtr padding,
        byte[] output, int outputLength, out int written, int flags);
    [DllImport("ncrypt.dll")]
    private static extern int NCryptFreeObject(IntPtr handle);

    private static byte[] ChromeWrappedKey(byte[] payload)
    {
        if (payload.Length < 8) throw new InvalidOperationException("Invalid Chrome key data.");
        int headerLength = BitConverter.ToInt32(payload, 0);
        if (headerLength < 0 || headerLength > 4096 || headerLength > payload.Length - 8)
            throw new InvalidOperationException("Invalid Chrome key header.");
        int offset = 4 + headerLength;
        int contentLength = BitConverter.ToInt32(payload, offset);
        offset += 4;
        // Chrome 137+: flag 3 | 32-byte CNG-wrapped AES key | IV | ciphertext | tag.
        // Refuse future formats rather than returning an incorrect cookie key.
        if (contentLength != 93 || offset + contentLength != payload.Length || payload[offset] != 3)
            throw new InvalidOperationException("Unsupported Chrome App-Bound key format.");
        byte[] wrapped = new byte[32];
        Buffer.BlockCopy(payload, offset + 1, wrapped, 0, wrapped.Length);
        return wrapped;
    }

    private static void RunSystemCng(string input, string result)
    {
        if (WindowsIdentity.GetCurrent().User.Value != "S-1-5-18") throw new UnauthorizedAccessException("SYSTEM is required.");
        byte[] encrypted = File.ReadAllBytes(input);
        if (encrypted.Length != 32) throw new InvalidOperationException("Invalid Chrome CNG ciphertext.");
        IntPtr provider = IntPtr.Zero;
        IntPtr key = IntPtr.Zero;
        byte[] clear = null;
        try
        {
            int status = NCryptOpenStorageProvider(out provider, "Microsoft Software Key Storage Provider", 0);
            if (status != 0) throw new InvalidOperationException("Chrome CNG provider unavailable (" + status.ToString("X8") + ").");
            status = NCryptOpenKey(provider, out key, "Google Chromekey1", 0, 0);
            if (status != 0) throw new InvalidOperationException("Chrome CNG key unavailable (" + status.ToString("X8") + ").");
            int length;
            status = NCryptDecrypt(key, encrypted, encrypted.Length, IntPtr.Zero, null, 0, out length, 0x40);
            if (status != 0 || length != 32) throw new InvalidOperationException("Chrome CNG key size invalid.");
            clear = new byte[length];
            status = NCryptDecrypt(key, encrypted, encrypted.Length, IntPtr.Zero, clear, clear.Length, out length, 0x40);
            if (status != 0 || length != 32) throw new InvalidOperationException("Chrome CNG key could not be opened.");
            // The temporary directory is accessible only to Administrators and
            // SYSTEM; the result is DPAPI-wrapped even within that directory.
            byte[] protectedKey = ProtectedData.Protect(clear, null, DataProtectionScope.LocalMachine);
            try { File.WriteAllBytes(result, protectedKey); }
            finally { Array.Clear(protectedKey, 0, protectedKey.Length); }
        }
        finally
        {
            if (clear != null) Array.Clear(clear, 0, clear.Length);
            Array.Clear(encrypted, 0, encrypted.Length);
            if (key != IntPtr.Zero) NCryptFreeObject(key);
            if (provider != IntPtr.Zero) NCryptFreeObject(provider);
        }
    }

    private static void RunSystemTask(string exe, string dir, string name, string args, string result)
    {
        string taskXml = Path.Combine(dir, "task.xml");
        string xml = "<?xml version=\"1.0\" encoding=\"UTF-16\"?>"
            + "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">"
            + "<Principals><Principal id=\"Author\"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>"
            + "<Settings><ExecutionTimeLimit>PT30S</ExecutionTimeLimit><AllowStartOnDemand>true</AllowStartOnDemand></Settings>"
            + "<Actions Context=\"Author\"><Exec><Command>" + SecurityElement.Escape(exe)
            + "</Command><Arguments>" + SecurityElement.Escape(args) + "</Arguments></Exec></Actions></Task>";
        File.WriteAllText(taskXml, xml, Encoding.Unicode);
        bool registered = false;
        try
        {
            RunTaskCommand("/Create /F /TN " + name + " /XML " + Quote(taskXml));
            registered = true;
            RunTaskCommand("/Run /TN " + name);
            for (int i = 0; i < 120 && !File.Exists(result); i++) Thread.Sleep(250);
            if (!File.Exists(result)) throw new InvalidOperationException("The browser key could not be unlocked by Windows.");
        }
        finally
        {
            if (registered) { try { RunTaskCommand("/Delete /F /TN " + name); } catch { /* preserve original error */ } }
        }
    }

    private static void RunElevated(string browser, string expectedSid, string output)
    {
        if (WindowsIdentity.GetCurrent().User.Value != expectedSid)
            throw new UnauthorizedAccessException("Administrator approval must be for the signed-in Windows account.");
        // The service must execute a copy that the unprivileged user cannot swap
        // between the approval and Task Scheduler starting it as SYSTEM.
        string id = Guid.NewGuid().ToString("N");
        string taskName = "CoilCoilBrowserImport-" + id;
        string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), taskName);
        DirectorySecurity acl = new DirectorySecurity();
        acl.SetAccessRuleProtection(true, false);
        InheritanceFlags inherited = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, inherited, PropagationFlags.None, AccessControlType.Allow));
        acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl, inherited, PropagationFlags.None, AccessControlType.Allow));
        Directory.CreateDirectory(dir, acl);
        string exe = Path.Combine(dir, "import-helper.exe");
        string result = Path.Combine(dir, "user-protected.bin");
        try
        {
            File.Copy(Assembly.GetExecutingAssembly().Location, exe);
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            RunSystemTask(exe, dir, taskName,
                "--system " + browser + " " + Quote(localAppData) + " " + Quote(result), result);
            if (browser == "chrome")
            {
                byte[] protectedKey = File.ReadAllBytes(result);
                byte[] payload = null;
                byte[] wrapped = null;
                byte[] clearCng = null;
                try
                {
                    payload = ProtectedData.Unprotect(protectedKey, null, DataProtectionScope.CurrentUser);
                    wrapped = ChromeWrappedKey(payload);
                    string input = Path.Combine(dir, "cng-input.bin");
                    string cngResult = Path.Combine(dir, "cng-result.bin");
                    File.WriteAllBytes(input, wrapped); // Still encrypted by Chrome's CNG key.
                    RunSystemTask(exe, dir, taskName + "-cng",
                        "--system-cng " + Quote(input) + " " + Quote(cngResult), cngResult);
                    byte[] machineProtected = File.ReadAllBytes(cngResult);
                    try { clearCng = ProtectedData.Unprotect(machineProtected, null, DataProtectionScope.LocalMachine); }
                    finally { Array.Clear(machineProtected, 0, machineProtected.Length); }
                    if (clearCng.Length != 32) throw new InvalidOperationException("Invalid Chrome CNG key size.");
                    byte[] userProtected = ProtectedData.Protect(clearCng, null, DataProtectionScope.CurrentUser);
                    try { File.WriteAllBytes(output + ".cng", userProtected); }
                    finally { Array.Clear(userProtected, 0, userProtected.Length); }
                }
                finally
                {
                    Array.Clear(protectedKey, 0, protectedKey.Length);
                    if (payload != null) Array.Clear(payload, 0, payload.Length);
                    if (wrapped != null) Array.Clear(wrapped, 0, wrapped.Length);
                    if (clearCng != null) Array.Clear(clearCng, 0, clearCng.Length);
                }
            }
            File.Copy(result, output, true);
        }
        finally { try { Directory.Delete(dir, true); } catch { /* all browser keys there are encrypted */ } }
    }

    private static void RunRequest(string browser)
    {
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        byte[] legacyEncrypted = StateKey(browser, localAppData, "encrypted_key", "DPAPI");
        byte[] appBoundEncrypted = StateKey(browser, localAppData, "app_bound_encrypted_key", "APPB");
        byte[] legacy = null;
        byte[] appBound = null;
        byte[] chromePayload = null;
        byte[] chromeCngKey = null;
        string output = Path.Combine(Path.GetTempPath(), "coilcoil-import-" + Guid.NewGuid().ToString("N") + ".bin");
        try
        {
            if (legacyEncrypted != null)
                legacy = ProtectedData.Unprotect(legacyEncrypted, null, DataProtectionScope.CurrentUser);
            if (appBoundEncrypted != null)
            {
                string sid = WindowsIdentity.GetCurrent().User.Value;
                ProcessStartInfo elevated = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,
                    "--elevated " + browser + " " + sid + " " + Quote(output));
                elevated.UseShellExecute = true;
                elevated.Verb = "runas";
                using (Process process = Process.Start(elevated))
                {
                    if (!process.WaitForExit(45000)) { try { process.Kill(); } catch {} throw new TimeoutException("Administrator approval timed out."); }
                    if (process.ExitCode != 0) throw new InvalidOperationException("Administrator approval or browser key access failed.");
                }
                byte[] protectedKey = File.ReadAllBytes(output);
                try
                {
                    byte[] payload = ProtectedData.Unprotect(protectedKey, null, DataProtectionScope.CurrentUser);
                    try
                    {
                        if (browser == "chrome")
                        {
                            byte[] wrapped = ChromeWrappedKey(payload);
                            Array.Clear(wrapped, 0, wrapped.Length);
                            chromePayload = (byte[])payload.Clone();
                            byte[] cngProtected = File.ReadAllBytes(output + ".cng");
                            try { chromeCngKey = ProtectedData.Unprotect(cngProtected, null, DataProtectionScope.CurrentUser); }
                            finally { Array.Clear(cngProtected, 0, cngProtected.Length); }
                            if (chromeCngKey.Length != 32) throw new InvalidOperationException("Invalid Chrome CNG key.");
                        }
                        else
                        {
                            // Edge's verified format ends with a 32-byte key.
                            if (payload.Length != 73) throw new InvalidOperationException("Unsupported Edge App-Bound key format.");
                            appBound = new byte[32];
                            Buffer.BlockCopy(payload, payload.Length - 32, appBound, 0, 32);
                        }
                    }
                    finally { Array.Clear(payload, 0, payload.Length); }
                }
                finally { Array.Clear(protectedKey, 0, protectedKey.Length); }
            }
            if (legacy != null && legacy.Length != 32) throw new InvalidOperationException("Invalid legacy browser key.");
            Console.WriteLine("{\"legacy\":" + (legacy == null ? "null" : Quote(Convert.ToBase64String(legacy)))
                + ",\"appBound\":" + (appBound == null ? "null" : Quote(Convert.ToBase64String(appBound)))
                + ",\"chromePayload\":" + (chromePayload == null ? "null" : Quote(Convert.ToBase64String(chromePayload)))
                + ",\"chromeCngKey\":" + (chromeCngKey == null ? "null" : Quote(Convert.ToBase64String(chromeCngKey))) + "}");
        }
        finally
        {
            if (legacyEncrypted != null) Array.Clear(legacyEncrypted, 0, legacyEncrypted.Length);
            if (appBoundEncrypted != null) Array.Clear(appBoundEncrypted, 0, appBoundEncrypted.Length);
            if (legacy != null) Array.Clear(legacy, 0, legacy.Length);
            if (appBound != null) Array.Clear(appBound, 0, appBound.Length);
            if (chromePayload != null) Array.Clear(chromePayload, 0, chromePayload.Length);
            if (chromeCngKey != null) Array.Clear(chromeCngKey, 0, chromeCngKey.Length);
            try { File.Delete(output); } catch { /* encrypted for this user only */ }
            try { File.Delete(output + ".cng"); } catch { /* encrypted for this user only */ }
        }
    }

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "--request") RunRequest(args[1]);
            else if (args.Length == 4 && args[0] == "--elevated") RunElevated(args[1], args[2], args[3]);
            else if (args.Length == 4 && args[0] == "--system") RunSystem(args[1], args[2], args[3]);
            else if (args.Length == 3 && args[0] == "--system-cng") RunSystemCng(args[1], args[2]);
            else throw new ArgumentException("Invalid import helper arguments.");
            return 0;
        }
        catch (Exception error)
        {
            System.ComponentModel.Win32Exception win32 = error as System.ComponentModel.Win32Exception;
            if (win32 != null && win32.NativeErrorCode == 1223)
            {
                Console.Error.WriteLine("Administrator approval was cancelled. No browser data was imported.");
                return 2;
            }
            Console.Error.WriteLine("Browser import helper failed: " + error.Message);
            return 1;
        }
    }
}
