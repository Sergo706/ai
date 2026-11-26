import { ToolHandler } from "../../types/ToolExecutionTypes";
import { getConfiguration } from "../../config/config";
import { toolError } from "../execution";
import { loadPeer } from "../../utils/loadPeerDepend";
import { currencyParams } from "./schemas";

/** The slice of `easy-currencies` this tool uses. */
interface EasyCurrenciesPeer {
  Convert: (amount: number) => {
    from: (code: string) => { to: (code: string) => Promise<number> };
  };
}

/**
 * Convert an amount between two currency codes.
 *
 * Backed by `easy-currencies`, which is loaded on first use because its rate
 * tables only matter when the tool is enabled.
 *
 * @returns A handler that takes `{ amount, from, to }` and returns
 * `{ amount, from, to, convertedAmount }`.
 */
export function currenciesConvertor(): ToolHandler {
  const log = getConfiguration().logger;
  return async (args) => {
    log.debug({ args }, "agent ran tool currenciesConvertor");

    const parse = currencyParams.safeParse(args);
    if (!parse.success) {
      return toolError("VALIDATION_ERROR", JSON.stringify(parse.error.issues));
    }

    const { amount, from, to } = parse.data;

    try {
      // Loaded per call: rate tables and the fetch they use are only worth
      // paying for when the host actually enables this tool.
      const { Convert } = await loadPeer<EasyCurrenciesPeer>(
        "easy-currencies",
        "the currency converter tool",
      );
      const value = await Convert(amount).from(from).to(to);
      return {
        amount,
        from,
        to,
        convertedAmount: value,
      };
    } catch (err) {
      log.error({ err }, "Currency conversion failed.");
      return toolError(
        "CONVERSION_FAILED",
        "Unable to convert currencies. Check if the currency codes are valid.",
      );
    }
  };
}
