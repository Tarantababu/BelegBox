import { redirect } from "next/navigation";
import { currentSession } from "../lib/api";

export default async function Home() {
  redirect((await currentSession()) ? "/inbox" : "/login");
}
