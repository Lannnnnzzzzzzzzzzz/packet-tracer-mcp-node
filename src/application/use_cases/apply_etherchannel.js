// Use case: bundle switch ports into an EtherChannel in PT.
// (Port of application/use_cases/apply_etherchannel.py)

import { validate_etherchannel, validate_etherchannel_against_topology } from "../../domain/rules/etherchannel_rules.js";
import { generate_etherchannel_cli } from "../../infrastructure/generator/etherchannel_cli_generator.js";
import { run_ios_feature } from "./apply_router_features.js";

export function apply_etherchannel_uc(cfg, query_pt_topology = null, bridge_send = null, dry_run = false) {
    return run_ios_feature(cfg, cfg.switch, validate_etherchannel,
                           validate_etherchannel_against_topology, generate_etherchannel_cli,
                           query_pt_topology, bridge_send, dry_run);
}
