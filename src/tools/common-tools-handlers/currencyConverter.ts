import { Convert } from "easy-currencies";
import { ToolHandler } from "../../types/ToolExecutionTypes";
import { getConfiguration } from "../../config/config";
import { toolError } from "../execution";
import { currencyParams } from "./schemas";


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
