import { startServer } from "./api/server.js";

startServer().catch((error) => {
  // Mensagem amigável para erros comuns
  if (
    error.message?.includes("playwright") ||
    error.message?.includes("browser")
  ) {
    console.error("❌ Erro ao iniciar: Playwright pode não estar instalado.");
    console.error("   Execute: npx playwright install");
  } else {
    console.error("❌ Falha ao iniciar o servidor:", error.message);
  }
  process.exit(1);
});
