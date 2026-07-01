// Workspace entry. Importing the mapper + pipeline modules runs their
// registration side effects; the engine reads the populated registries back
// from these re-exports at boot.
import "./mappers";
import "./pipelines";

export { MapperRegistry, PipelineRegistry } from "@healthsamurai/interbox";
