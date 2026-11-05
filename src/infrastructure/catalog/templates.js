// Formal topology templates. (Port of infrastructure/catalog/templates.py)
//
// Each template defines default values and constraints
// that the orchestrator uses to generate plans.

import { TopologyTemplate, RoutingProtocol } from "../../shared/enums.js";


export class TemplateSpec {
    /** Specification of a topology template. */
    // Python: @dataclass(frozen=True) with fields (name, key, description,
    // min_routers=1, max_routers=20, default_routers=2, default_pcs_per_lan=3,
    // default_switches_per_router=1, requires_wan=False,
    // default_routing=RoutingProtocol.STATIC, tags=()).
    // Accepts an object with those field names, or the positional form
    // new TemplateSpec(name, key, description, { ...rest }).
    constructor(name, key, description, rest) {
        if (name !== null && typeof name === "object") {
            const obj = name;
            this.name = obj.name;
            this.key = obj.key;
            this.description = obj.description;
            this.min_routers = obj.min_routers !== undefined ? obj.min_routers : 1;
            this.max_routers = obj.max_routers !== undefined ? obj.max_routers : 20;
            this.default_routers = obj.default_routers !== undefined ? obj.default_routers : 2;
            this.default_pcs_per_lan = obj.default_pcs_per_lan !== undefined ? obj.default_pcs_per_lan : 3;
            this.default_switches_per_router = obj.default_switches_per_router !== undefined ? obj.default_switches_per_router : 1;
            this.requires_wan = obj.requires_wan !== undefined ? obj.requires_wan : false;
            this.default_routing = obj.default_routing !== undefined ? obj.default_routing : RoutingProtocol.STATIC;
            this.tags = obj.tags !== undefined ? [...obj.tags] : [];
        } else {
            const obj = rest || {};
            this.name = name;
            this.key = key;
            this.description = description;
            this.min_routers = obj.min_routers !== undefined ? obj.min_routers : 1;
            this.max_routers = obj.max_routers !== undefined ? obj.max_routers : 20;
            this.default_routers = obj.default_routers !== undefined ? obj.default_routers : 2;
            this.default_pcs_per_lan = obj.default_pcs_per_lan !== undefined ? obj.default_pcs_per_lan : 3;
            this.default_switches_per_router = obj.default_switches_per_router !== undefined ? obj.default_switches_per_router : 1;
            this.requires_wan = obj.requires_wan !== undefined ? obj.requires_wan : false;
            this.default_routing = obj.default_routing !== undefined ? obj.default_routing : RoutingProtocol.STATIC;
            this.tags = obj.tags !== undefined ? [...obj.tags] : [];
        }
    }

    toDict() {
        return {
            name: this.name,
            key: this.key,
            description: this.description,
            min_routers: this.min_routers,
            max_routers: this.max_routers,
            default_routers: this.default_routers,
            default_pcs_per_lan: this.default_pcs_per_lan,
            default_switches_per_router: this.default_switches_per_router,
            requires_wan: this.requires_wan,
            default_routing: this.default_routing,
            tags: [...this.tags],
        };
    }
}


export const TEMPLATES = {
    [TopologyTemplate.SINGLE_LAN]: new TemplateSpec({
        name: "Single LAN",
        key: TopologyTemplate.SINGLE_LAN,
        description: "1 router + 1 switch + PCs. A simple local network.",
        min_routers: 1, max_routers: 1, default_routers: 1,
        default_pcs_per_lan: 5,
        tags: ["basic", "lan", "beginner"],
    }),
    [TopologyTemplate.MULTI_LAN]: new TemplateSpec({
        name: "Multi LAN",
        key: TopologyTemplate.MULTI_LAN,
        description: "N routers in a chain, each with its own LAN.",
        default_routers: 2, default_pcs_per_lan: 3,
        tags: ["intermediate", "multi-lan", "routing"],
    }),
    [TopologyTemplate.MULTI_LAN_WAN]: new TemplateSpec({
        name: "Multi LAN + WAN",
        key: TopologyTemplate.MULTI_LAN_WAN,
        description: "N routers with LANs + a WAN connection (Cloud).",
        default_routers: 3, default_pcs_per_lan: 3,
        requires_wan: true,
        tags: ["intermediate", "wan", "cloud"],
    }),
    [TopologyTemplate.STAR]: new TemplateSpec({
        name: "Star (Hub & Spoke)",
        key: TopologyTemplate.STAR,
        description: "1 central router connected to N switches.",
        min_routers: 1, max_routers: 1, default_routers: 1,
        default_switches_per_router: 3, default_pcs_per_lan: 4,
        tags: ["basic", "star", "centralized"],
    }),
    [TopologyTemplate.HUB_SPOKE]: new TemplateSpec({
        name: "Hub and Spoke",
        key: TopologyTemplate.HUB_SPOKE,
        description: "1 central hub router + N spoke routers, each with its own LAN.",
        default_routers: 4, default_pcs_per_lan: 2,
        tags: ["advanced", "wan", "hub-spoke"],
    }),
    [TopologyTemplate.BRANCH_OFFICE]: new TemplateSpec({
        name: "Branch Office",
        key: TopologyTemplate.BRANCH_OFFICE,
        description: "Head office + branches connected over WAN.",
        default_routers: 3, default_pcs_per_lan: 5,
        requires_wan: true,
        tags: ["enterprise", "branch", "wan"],
    }),
    [TopologyTemplate.THREE_ROUTER_TRIANGLE]: new TemplateSpec({
        name: "Three Router Triangle",
        key: TopologyTemplate.THREE_ROUTER_TRIANGLE,
        description: "3 routers in a triangle with redundancy.",
        min_routers: 3, max_routers: 3, default_routers: 3,
        default_pcs_per_lan: 3,
        default_routing: RoutingProtocol.OSPF,
        tags: ["advanced", "redundancy", "ospf"],
    }),
    [TopologyTemplate.ROUTER_ON_A_STICK]: new TemplateSpec({
        name: "Router on a Stick",
        key: TopologyTemplate.ROUTER_ON_A_STICK,
        description: "1 router + 1 switch with inter-VLAN routing (.1q subinterfaces).",
        min_routers: 1, max_routers: 1, default_routers: 1,
        default_switches_per_router: 1, default_pcs_per_lan: 6,
        tags: ["advanced", "vlan", "inter-vlan"],
    }),
    [TopologyTemplate.CUSTOM]: new TemplateSpec({
        name: "Custom",
        key: TopologyTemplate.CUSTOM,
        description: "Free-form topology — every parameter set by hand.",
        tags: ["free-form", "custom"],
    }),
};


export function get_template(key) {
    /** Returns the spec of a template. */
    return TEMPLATES[key];
}


export function list_templates() {
    /** Lists all templates with their details. */
    return Object.values(TEMPLATES);
}
