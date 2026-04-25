// Floating bottom-right pill that opens Northstar (the per-company CEO chat).
// Mounted globally in Layout so it's reachable from anywhere — except the
// Northstar route itself, where it would be redundant.
//
// Visual: small gradient pill, sparkle icon, sits above the Dia browser's own
// "Ask AI" button (z-50) so the user can still see ours.

import { Sparkles } from "lucide-react";
import { useLocation, useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";

export function NorthstarLauncher() {
  const navigate = useNavigate();
  const location = useLocation();
  const { selectedCompany } = useCompany();

  // Don't render on the Northstar page itself.
  if (location.pathname.startsWith("/northstar")) return null;
  // Hide until a company is picked — Northstar is per-company.
  if (!selectedCompany) return null;

  return (
    <button
      type="button"
      onClick={() => navigate("/northstar")}
      title={`Talk to ${selectedCompany.name}'s CEO`}
      className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-full border border-border/50 bg-gradient-to-br from-fuchsia-500 via-purple-500 to-indigo-500 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-purple-500/30 transition-transform hover:scale-[1.03] active:scale-[0.98]"
    >
      <Sparkles className="h-4 w-4" />
      Northstar
    </button>
  );
}
