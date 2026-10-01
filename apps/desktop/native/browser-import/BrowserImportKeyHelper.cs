// Windows-only helper. Run by CoilCoil after the user explicitly confirms importing
// a Chrome/Edge profile. Only the SYSTEM DPAPI wrapper is opened with elevation;
// the inner USER DPAPI wrapper and the actual cookie key never leave the user's
// process. No browser process is injected into and no browser data is modified.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
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
        string taskXml = Path.Combine(dir, "task.xml");
        bool registered = false;
        try
        {
            File.Copy(Assembly.GetExecutingAssembly().Location, exe);
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string args = "--system " + browser + " " + Quote(localAppData) + " " + Quote(result);
            string xml = "<?xml version=\"1.0\" encoding=\"UTF-16\"?>"
                + "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">"
                + "<Principals><Principal id=\"Author\"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>"
                + "<Settings><ExecutionTimeLimit>PT30S</ExecutionTimeLimit><AllowStartOnDemand>true</AllowStartOnDemand></Settings>"
                + "<Actions Context=\"Author\"><Exec><Command>" + SecurityElement.Escape(exe)
                + "</Command><Arguments>" + SecurityElement.Escape(args) + "</Arguments></Exec></Actions></Task>";
            File.WriteAllText(taskXml, xml, Encoding.Unicode);
            RunTaskCommand("/Create /F /TN " + taskName + " /XML " + Quote(taskXml));
            registered = true;
            RunTaskCommand("/Run /TN " + taskName);
            for (int i = 0; i < 120 && !File.Exists(result); i++) Thread.Sleep(250);
            if (!File.Exists(result)) throw new InvalidOperationException("The browser key could not be unlocked by Windows.");
            File.Copy(result, output, true);
        }
        finally
        {
            if (registered) { try { RunTaskCommand("/Delete /F /TN " + taskName); } catch { /* keep original error */ } }
            try { Directory.Delete(dir, true); } catch { /* a failed cleanup must not expose plaintext */ }
        }
    }

    private static void RunRequest(string browser)
    {
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        byte[] legacyEncrypted = StateKey(browser, localAppData, "encrypted_key", "DPAPI");
        byte[] appBoundEncrypted = StateKey(browser, localAppData, "app_bound_encrypted_key", "APPB");
        byte[] legacy = null;
        byte[] appBound = null;
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
                        // Chromium stores versioned metadata before the AES-256 key.
                        // Only the trailing 32 bytes are the cookie key; reject any
                        // unexpected short payload rather than guessing a value.
                        if (payload.Length < 33) throw new InvalidOperationException("Unsupported App-Bound key format.");
                        appBound = new byte[32];
                        Buffer.BlockCopy(payload, payload.Length - 32, appBound, 0, 32);
                    }
                    finally { Array.Clear(payload, 0, payload.Length); }
                }
                finally { Array.Clear(protectedKey, 0, protectedKey.Length); }
            }
            if (legacy != null && legacy.Length != 32) throw new InvalidOperationException("Invalid legacy browser key.");
            Console.WriteLine("{\"legacy\":" + (legacy == null ? "null" : Quote(Convert.ToBase64String(legacy)))
                + ",\"appBound\":" + (appBound == null ? "null" : Quote(Convert.ToBase64String(appBound))) + "}");
        }
        finally
        {
            if (legacyEncrypted != null) Array.Clear(legacyEncrypted, 0, legacyEncrypted.Length);
            if (appBoundEncrypted != null) Array.Clear(appBoundEncrypted, 0, appBoundEncrypted.Length);
            if (legacy != null) Array.Clear(legacy, 0, legacy.Length);
            if (appBound != null) Array.Clear(appBound, 0, appBound.Length);
            try { File.Delete(output); } catch { /* encrypted for this user only */ }
        }
    }

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "--request") RunRequest(args[1]);
            else if (args.Length == 4 && args[0] == "--elevated") RunElevated(args[1], args[2], args[3]);
            else if (args.Length == 4 && args[0] == "--system") RunSystem(args[1], args[2], args[3]);
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
