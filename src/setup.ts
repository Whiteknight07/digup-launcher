import { showToast, Toast } from "@raycast/api";
import { openSetup } from "./bridge";

export default async function Command() {
  try {
    await openSetup();
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Could not open DigUp",
      message: String(error),
    });
  }
}
