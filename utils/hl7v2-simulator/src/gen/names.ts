import { Faker, base, en, de } from "@faker-js/faker";

export interface NameProvider {
  firstName(): string;
  lastName(): string;
}

// Deterministic per (locale, seed): same inputs -> same name sequence.
export function fakerNames(locale: "en" | "de", seed: number): NameProvider {
  const f = new Faker({ locale: [locale === "de" ? de : en, base] });
  f.seed(seed);
  return {
    firstName: () => f.person.firstName(),
    lastName: () => f.person.lastName(),
  };
}
