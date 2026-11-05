// Infrastructure catalog. (Port of infrastructure/catalog/__init__.py)

export {
    ALL_MODELS, DeviceModel, PortSpec,
    resolve_model, get_ports_by_speed, get_valid_ports,
} from "./devices.js";
export { CABLE_TYPES, CABLE_RULES, ALL_LINK_TYPES, infer_cable } from "./cables.js";
export { MODEL_ALIASES } from "./aliases.js";
export { TEMPLATES, get_template, list_templates, TemplateSpec } from "./templates.js";
export { ALL_MODULES, ModuleSpec, resolve_module, get_serial_module, SERIAL_MODULES } from "./modules.js";
