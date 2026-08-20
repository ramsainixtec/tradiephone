import { PageHeader } from "@/components/layout/PageHeader";
import { HumanTransferCard } from "@/components/transfer/HumanTransferCard";

/**
 * Human Call Transfer — standalone tenant page (sidebar: under Call Forwarding).
 * Lets the owner enable transfer, set the number calls are transferred to, the
 * waiting time, and the end message spoken when the transfer can't connect.
 */
export default function HumanTransferPage() {
  return (
    <div>
      <PageHeader
        title="Call Transfer"
        subtitle="When a caller asks for a real person, the AI transfers the call to your number."
      />
      <div className="mt-6">
        <HumanTransferCard />
      </div>
    </div>
  );
}
