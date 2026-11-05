// Input DTOs for the application layer. (Port of application/dto/requests.py)

import { RoutingProtocol, TopologyTemplate } from "../../shared/enums.js";

// Basic pydantic coercion: numeric strings for int fields are coerced.
function _coerce_int(v) {
    if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return parseInt(v, 10);
    return v;
}

export class PlanTopologyDTO {
    /** DTO for planning a topology. */
    constructor(obj = {}) {
        this.routers = obj.routers === undefined ? 2 : _coerce_int(obj.routers);
        this.pcs_per_lan = obj.pcs_per_lan === undefined ? 2
            : (Array.isArray(obj.pcs_per_lan) ? [...obj.pcs_per_lan] : _coerce_int(obj.pcs_per_lan));
        this.switches_per_router = obj.switches_per_router === undefined ? 1 : _coerce_int(obj.switches_per_router);
        this.servers = obj.servers === undefined ? 0 : _coerce_int(obj.servers);
        this.has_wan = obj.has_wan === undefined ? false : obj.has_wan;
        this.dhcp = obj.dhcp === undefined ? true : obj.dhcp;
        this.routing = obj.routing === undefined ? "static" : obj.routing;
        this.template = obj.template === undefined ? null : obj.template;
        this.router_model = obj.router_model === undefined ? null : obj.router_model;
        this.switch_model = obj.switch_model === undefined ? null : obj.switch_model;
        this.lan_base = obj.lan_base === undefined ? null : obj.lan_base;
        this.link_base = obj.link_base === undefined ? null : obj.link_base;
        this.vlans = obj.vlans === undefined ? 0 : _coerce_int(obj.vlans);
        this.dual_stack = obj.dual_stack === undefined ? false : obj.dual_stack;
        this.ipv6_base = obj.ipv6_base === undefined ? null : obj.ipv6_base;
        this.wireless_laptops = obj.wireless_laptops === undefined ? false : obj.wireless_laptops;
    }

    toDict() {
        return {
            routers: this.routers,
            pcs_per_lan: this.pcs_per_lan,
            switches_per_router: this.switches_per_router,
            servers: this.servers,
            has_wan: this.has_wan,
            dhcp: this.dhcp,
            routing: this.routing,
            template: this.template,
            router_model: this.router_model,
            switch_model: this.switch_model,
            lan_base: this.lan_base,
            link_base: this.link_base,
            vlans: this.vlans,
            dual_stack: this.dual_stack,
            ipv6_base: this.ipv6_base,
            wireless_laptops: this.wireless_laptops,
        };
    }
}

export class FixPlanDTO {
    /** DTO for fixing a plan. */
    constructor(obj = {}) {
        this.plan_json = obj.plan_json;
    }

    toDict() {
        return {
            plan_json: this.plan_json,
        };
    }
}

export class ExportDTO {
    /** DTO for exporting artifacts. */
    constructor(obj = {}) {
        this.plan_json = obj.plan_json;
        this.project_name = obj.project_name === undefined ? null : obj.project_name;
        this.output_dir = obj.output_dir === undefined ? "projects" : obj.output_dir;
    }

    toDict() {
        return {
            plan_json: this.plan_json,
            project_name: this.project_name,
            output_dir: this.output_dir,
        };
    }
}
