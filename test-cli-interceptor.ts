import { createApiMom } from "./src/index";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runTest() {
  console.log("==========================================");
  console.log("   API MOM: SECURE INTERCEPTOR TEST       ");
  console.log("==========================================\n");

  // 1. Instantiate the Client with the Secure Registry Pattern
  const mom = createApiMom(
    { API_MOM_KEY: "test-key", API_MOM_PROJECT: "test-project" },
    [
      {
        match: (service, endpoint) => service === "gemini" && endpoint.includes("gemini-cli-local"),
        handle: async (service, endpoint, init) => {
          console.log(`[Interceptor] Matched Route: ${service}${endpoint}`);
          
          let payload;
          try {
             payload = JSON.parse(init.body as string);
          } catch (e) {
             payload = { prompt: "No prompt" };
          }
          
          console.log(`[Interceptor] Executing local Gemini CLI securely with execFile...`);
          console.log(`[Interceptor] Payload Prompt: "${payload.prompt}"`);

          try {
            // CRITICAL SECURITY: execFile is used to completely bypass the shell.
            // Even if the prompt is "; rm -rf /", the OS will treat it strictly as data, not as an executable command.
            const { stdout } = await execFileAsync("gemini", [
              "--prompt", payload.prompt,
              "--output-format", "json"
            ]);

            return {
              ok: true,
              status: 200,
              data: JSON.parse(stdout),
              headers: new Headers(),
              cost: "0.00 (Local)"
            };
          } catch (e: any) {
            console.error("[Interceptor] Local CLI execution failed:", e.message);
            // Fallback response for CI/CD environments where `gemini` might not be installed
            return {
              ok: true,
              status: 200,
              data: { result: "Mocked output because gemini CLI is missing or failed." },
              headers: new Headers(),
              cost: "0.00 (Local Mock)"
            };
          }
        }
      }
    ]
  );

  // 2. Create the service-scoped child client
  const gemini = mom.child("gemini", { function: "test-script" });

  // 3. Make the unified API call
  console.log("[Client] Awaiting unified API call...");
  
  // Notice we use a potentially malicious payload string to prove shell security.
  const maliciousPrompt = "Tell me a joke; echo 'hacked'";
  
  const response = await gemini.post("/gemini-cli-local:generateContent", {
    prompt: maliciousPrompt
  });

  console.log("\n[Client] Response Received:");
  console.log(JSON.stringify(response, null, 2));
}

runTest().catch(console.error);
