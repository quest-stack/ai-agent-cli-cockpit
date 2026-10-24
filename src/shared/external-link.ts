import { z } from "zod";

// Validate the original text: Zod's URL format may normalize away controls
// before later refinements. The platform URL parser below checks syntax.
const externalWebUrlSchema = z.string().refine((value) => {
  try {
    const url = new globalThis.URL(value);
    return (
      /^https?:\/\/\S+$/iu.test(value) &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
});

/** URLは認証情報を含みうるため、失敗時もログへ出さない。 */
export async function openExternalWebLink(
  value: unknown,
  open: (url: string) => Promise<void>,
): Promise<boolean> {
  const parsed = externalWebUrlSchema.safeParse(value);
  if (!parsed.success) {
    return false;
  }
  try {
    await open(parsed.data);
    return true;
  } catch {
    return false;
  }
}
