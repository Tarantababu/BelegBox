import { redirect } from "next/navigation";
import { currentTenantId } from "../lib/api";

export default async function Home() {
  redirect((await currentTenantId()) ? "/inbox" : "/setup");
}
