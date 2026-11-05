// Use case: plan topology. (Port of application/use_cases/plan_topology.py)

import { TopologyRequest } from "../../domain/models/requests.js";
import { plan_from_request } from "../../domain/services/orchestrator.js";
import { RoutingProtocol, TopologyTemplate, enumByValue } from "../../shared/enums.js";
import { DEFAULT_LAN_BASE, DEFAULT_LINK_BASE } from "../../shared/constants.js";

// Python `Enum(value)`: raises ValueError if the value is not a member.
function _enum_value(enumObj, enumName, value) {
    const v = enumByValue(enumObj, value);
    if (v === undefined) {
        throw new Error(`'${value}' is not a valid ${enumName}`);
    }
    return v;
}

export function plan_topology(dto) {
    /** Creates a plan from a DTO. */
    const kwargs = {
        routers: dto.routers,
        pcs_per_lan: dto.pcs_per_lan,
        switches_per_router: dto.switches_per_router,
        servers: dto.servers,
        has_wan: dto.has_wan,
        dhcp: dto.dhcp,
        routing: _enum_value(RoutingProtocol, "RoutingProtocol", dto.routing),
        vlans: dto.vlans,
        dual_stack: dto.dual_stack,
        wireless_laptops: dto.wireless_laptops,
    };
    if (dto.template) {
        kwargs["template"] = _enum_value(TopologyTemplate, "TopologyTemplate", dto.template);
    }
    if (dto.ipv6_base) {
        kwargs["ipv6_base"] = dto.ipv6_base;
    }
    if (dto.router_model) {
        kwargs["router_model"] = dto.router_model;
    }
    if (dto.switch_model) {
        kwargs["switch_model"] = dto.switch_model;
    }
    if (dto.lan_base) {
        kwargs["base_network"] = dto.lan_base;
    }
    if (dto.link_base) {
        kwargs["inter_router_network"] = dto.link_base;
    }

    const request = new TopologyRequest(kwargs);
    return plan_from_request(request);
}
