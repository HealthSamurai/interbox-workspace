import type { CWE } from "@health-samurai/interbox/hl7v2";
import type { Annotation, CodeableConcept, Coding, Duration, Identifier } from "@health-samurai/interbox/fhir/4.0.1";

export function convertCWEToCodeableConcept(cwe: CWE | undefined): CodeableConcept | undefined {
  if (!cwe) {return undefined;}

  const codings: Coding[] = [];

  if (cwe.$1_code || cwe.$2_text) {
    codings.push({
      ...(cwe.$1_code && { code: cwe.$1_code }),
      ...(cwe.$2_text && { display: cwe.$2_text }),
      ...(cwe.$3_system && { system: cwe.$3_system }),
      ...(cwe.$7_version && { version: cwe.$7_version }),
    });
  }

  if (cwe.$4_altCode || cwe.$5_altDisplay) {
    codings.push({
      ...(cwe.$4_altCode && { code: cwe.$4_altCode }),
      ...(cwe.$5_altDisplay && { display: cwe.$5_altDisplay }),
      ...(cwe.$6_altSystem && { system: cwe.$6_altSystem }),
      ...(cwe.$8_altVersion && { version: cwe.$8_altVersion }),
    });
  }

  if (codings.length === 0) {return undefined;}

  return {
    coding: codings,
    ...(cwe.$9_originalText ? { text: cwe.$9_originalText } : cwe.$2_text && { text: cwe.$2_text }),
  };
}

export function convertCWEToCoding(cwe: CWE | undefined): Coding | undefined {
  if (!cwe) {return undefined;}
  if (!cwe.$1_code && !cwe.$2_text) {return undefined;}

  return {
    ...(cwe.$1_code && { code: cwe.$1_code }),
    ...(cwe.$2_text && { display: cwe.$2_text }),
    ...(cwe.$3_system && { system: cwe.$3_system }),
    ...(cwe.$7_version && { version: cwe.$7_version }),
  };
}

export function convertCWEToCode(cwe: CWE | undefined): string | undefined {
  return cwe?.$1_code;
}

export function convertCWEToAnnotation(cwe: CWE | undefined): Annotation | undefined {
  if (!cwe) {return undefined;}

  const parts: string[] = [];
  if (cwe.$1_code) {parts.push(cwe.$1_code);}
  if (cwe.$2_text) {parts.push(cwe.$2_text);}
  if (cwe.$3_system) {parts.push(cwe.$3_system);}
  if (cwe.$4_altCode) {parts.push(cwe.$4_altCode);}
  if (cwe.$5_altDisplay) {parts.push(cwe.$5_altDisplay);}
  if (cwe.$6_altSystem) {parts.push(cwe.$6_altSystem);}
  if (cwe.$7_version) {parts.push(cwe.$7_version);}
  if (cwe.$8_altVersion) {parts.push(cwe.$8_altVersion);}
  if (cwe.$9_originalText) {parts.push(cwe.$9_originalText);}

  if (parts.length === 0) {return undefined;}

  return {
    text: parts.join("^"),
  };
}

export function convertCWEToDuration(cwe: CWE | undefined): Duration | undefined {
  if (!cwe) {return undefined;}

  const code = cwe.$1_code || cwe.$2_text;
  if (!code) {return undefined;}

  return {
    code,
  };
}

export function convertCWEToIdentifier(cwe: CWE | undefined): Identifier[] | undefined {
  if (!cwe) {return undefined;}

  const identifiers: Identifier[] = [];

  if (cwe.$1_code) {
    identifiers.push({
      value: cwe.$1_code,
      ...(cwe.$3_system && { system: cwe.$3_system }),
    });
  }

  if (cwe.$4_altCode) {
    identifiers.push({
      value: cwe.$4_altCode,
      ...(cwe.$6_altSystem && { system: cwe.$6_altSystem }),
    });
  }

  if (identifiers.length === 0) {return undefined;}

  return identifiers;
}
