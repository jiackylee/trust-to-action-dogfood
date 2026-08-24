import { Navigate, Route, Routes } from "react-router-dom";
import { Shell } from "./components/Shell";
import { Dashboard } from "./pages/Dashboard";
import { WeeklyWorkspace } from "./pages/WeeklyWorkspace";
import { ContentWorkspace } from "./pages/ContentWorkspace";
import { ProofLibrary } from "./pages/ProofLibrary";
import { CustomerDetail, Customers } from "./pages/Customers";
import { Execution } from "./pages/Execution";
import { Governance } from "./pages/Governance";
import { Insights } from "./pages/Insights";
import { AiQuality } from "./pages/AiQuality";
import { KnowledgeGovernance } from "./pages/KnowledgeGovernance";

export function App() {
  return <Routes><Route element={<Shell />}>
    <Route index element={<Dashboard />} />
    <Route path="weekly" element={<WeeklyWorkspace />} />
    <Route path="content" element={<ContentWorkspace />} />
    <Route path="proofs" element={<ProofLibrary />} />
    <Route path="insights" element={<Insights />} />
    <Route path="customers" element={<Customers />} />
    <Route path="customers/:customerId" element={<CustomerDetail />} />
    <Route path="execution" element={<Execution />} />
    <Route path="governance" element={<Governance />} />
    <Route path="ai-quality" element={<AiQuality />} />
    <Route path="knowledge" element={<KnowledgeGovernance />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Route></Routes>;
}
