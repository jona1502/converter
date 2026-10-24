"""HTTP-Schicht: Router, Middleware und einheitliche Fehlerantworten."""

# Jeder Router trägt den vollen Präfix selbst (z. B. f"{API_PREFIX}/health"),
# statt per verschachteltem include_router(prefix=...) zusammengesetzt zu
# werden: Nur so enthält die getroffene Route im Scope die vollständige
# Pfadvorlage, die die Middleware loggt.
API_PREFIX = "/api/v1"
