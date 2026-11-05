// Expansion module catalog for Packet Tracer. (Port of infrastructure/catalog/modules.py)
//
// Modules are installed in device slots to add extra ports
// (serial, ethernet, wireless, etc.)
//
// Each module has a numeric type that PTBuilder uses internally,
// and one or more ports that it adds to the device.


export class ModuleSpec {
    /** Specification of an expansion module. */
    // Python: @dataclass(frozen=True) with fields (name, module_type, category,
    // ports_added, description="", compatible_with=()).
    // Accepts an object with those field names, or the Python positional form
    // new ModuleSpec(name, module_type, category, ports_added, description, compatible_with).
    constructor(name, module_type, category, ports_added, description = "", compatible_with = []) {
        if (name !== null && typeof name === "object") {
            const obj = name;
            this.name = obj.name;
            this.module_type = obj.module_type;
            this.category = obj.category;
            this.ports_added = obj.ports_added !== undefined ? [...obj.ports_added] : [];
            this.description = obj.description !== undefined ? obj.description : "";
            this.compatible_with = obj.compatible_with !== undefined ? [...obj.compatible_with] : [];
        } else {
            this.name = name;
            this.module_type = module_type;
            this.category = category;
            this.ports_added = ports_added !== undefined ? [...ports_added] : [];
            this.description = description;
            this.compatible_with = compatible_with !== undefined ? [...compatible_with] : [];
        }
    }

    toDict() {
        return {
            name: this.name,
            module_type: this.module_type,
            category: this.category,
            ports_added: [...this.ports_added],
            description: this.description,
            compatible_with: [...this.compatible_with],
        };
    }
}


// =====================================================================
// Type 1 — Router NM Modules (Network Modules)
// =====================================================================
// Only the ISR G1 / 2600 series routers and the generic Router-PT accept NM.
// The ISR G2 (1941/2901/2911) have NO NM slot — only HWIC + SM.
// For 4 serials on a 2911, install 2× HWIC-2T in slots "0/0" and "0/1".
const _NM_COMPATIBLE = ["Router-PT", "Router-PT-Empty", "2811", "2620XM", "2621XM"];

export const NM_1E = new ModuleSpec({
    name: "NM-1E", module_type: 1, category: "router_nm",
    ports_added: ["Ethernet1/0"],
    description: "1-port Ethernet",
    compatible_with: _NM_COMPATIBLE,
});
export const NM_1E2W = new ModuleSpec({
    name: "NM-1E2W", module_type: 1, category: "router_nm",
    ports_added: ["Ethernet1/0"],
    description: "1-port Ethernet + 2 WIC slots",
    compatible_with: _NM_COMPATIBLE,
});
export const NM_1FE_FX = new ModuleSpec({
    name: "NM-1FE-FX", module_type: 1, category: "router_nm",
    ports_added: ["FastEthernet1/0"],
    description: "1-port FastEthernet (fiber)",
    compatible_with: _NM_COMPATIBLE,
});
export const NM_1FE_TX = new ModuleSpec({
    name: "NM-1FE-TX", module_type: 1, category: "router_nm",
    ports_added: ["FastEthernet1/0"],
    description: "1-port FastEthernet (copper)",
    compatible_with: _NM_COMPATIBLE,
});
export const NM_1FE2W = new ModuleSpec({
    name: "NM-1FE2W", module_type: 1, category: "router_nm",
    ports_added: ["FastEthernet1/0"],
    description: "1-port FastEthernet + 2 WIC slots",
    compatible_with: _NM_COMPATIBLE,
});
export const NM_2E2W = new ModuleSpec({
    name: "NM-2E2W", module_type: 1, category: "router_nm",
    ports_added: ["Ethernet1/0", "Ethernet1/1"],
    description: "2-port Ethernet + 2 WIC slots",
    compatible_with: _NM_COMPATIBLE,
});
export const NM_2FE2W = new ModuleSpec({
    name: "NM-2FE2W", module_type: 1, category: "router_nm",
    ports_added: ["FastEthernet1/0", "FastEthernet1/1"],
    description: "2-port FastEthernet + 2 WIC slots",
    compatible_with: _NM_COMPATIBLE,
});
export const NM_2W = new ModuleSpec({
    name: "NM-2W", module_type: 1, category: "router_nm",
    ports_added: [],
    description: "2 WIC slots only (no ports)",
    compatible_with: _NM_COMPATIBLE,
});
export const NM_4A_S = new ModuleSpec({
    name: "NM-4A/S", module_type: 1, category: "router_nm",
    ports_added: ["Serial1/0", "Serial1/1", "Serial1/2", "Serial1/3"],
    description: "4-port Async/Sync Serial — NOT supported on 2911 (use 2× HWIC-2T)",
    compatible_with: _NM_COMPATIBLE,
});
export const NM_4E = new ModuleSpec({
    name: "NM-4E", module_type: 1, category: "router_nm",
    ports_added: ["Ethernet1/0", "Ethernet1/1", "Ethernet1/2", "Ethernet1/3"],
    description: "4-port Ethernet",
    compatible_with: _NM_COMPATIBLE,
});
export const NM_8A_S = new ModuleSpec({
    name: "NM-8A/S", module_type: 1, category: "router_nm",
    ports_added: Array.from({ length: 8 }, (_, i) => `Serial1/${i}`),
    description: "8-port Async/Sync Serial",
    compatible_with: _NM_COMPATIBLE,
});
export const NM_8AM = new ModuleSpec({
    name: "NM-8AM", module_type: 1, category: "router_nm",
    ports_added: Array.from({ length: 8 }, (_, i) => `Modem1/${i}`),
    description: "8-port Analog Modem",
    compatible_with: _NM_COMPATIBLE,
});
export const NM_COVER = new ModuleSpec({
    name: "NM-Cover", module_type: 1, category: "router_nm",
    ports_added: [],
    description: "NM slot cover plate",
    compatible_with: _NM_COMPATIBLE,
});
export const NM_ESW_161 = new ModuleSpec({
    name: "NM-ESW-161", module_type: 1, category: "router_nm",
    ports_added: Array.from({ length: 16 }, (_, i) => `FastEthernet1/${i}`),
    description: "16-port Ethernet Switch module",
    compatible_with: _NM_COMPATIBLE,
});

// =====================================================================
// Type 2 — Router HWIC / WIC / NIM Modules
// =====================================================================
export const CELLULAR_1240 = new ModuleSpec({
    name: "1240-Cellular", module_type: 2, category: "router_hwic",
    ports_added: [],
    description: "Cellular module for CGR1240",
    compatible_with: ["CGR1240"],
});
export const COVER_1240 = new ModuleSpec({
    name: "1240-Cover", module_type: 2, category: "router_hwic",
    ports_added: [],
    description: "Cover plate for CGR1240",
    compatible_with: ["CGR1240"],
});
export const HWIC_1GE_SFP = new ModuleSpec({
    name: "HWIC-1GE-SFP", module_type: 2, category: "router_hwic",
    ports_added: ["GigabitEthernet0/0/0"],
    description: "1-port GigabitEthernet SFP",
    compatible_with: ["1941", "2901", "2911"],
});
export const HWIC_2T = new ModuleSpec({
    name: "HWIC-2T", module_type: 2, category: "router_hwic",
    ports_added: ["Serial0/0/0", "Serial0/0/1"],
    description: "2-port Serial WAN Interface Card",
    compatible_with: ["1941", "2901", "2911"],
});
export const HWIC_4ESW = new ModuleSpec({
    name: "HWIC-4ESW", module_type: 2, category: "router_hwic",
    ports_added: ["FastEthernet0/1/0", "FastEthernet0/1/1", "FastEthernet0/1/2", "FastEthernet0/1/3"],
    description: "4-port Ethernet Switch HWIC",
    compatible_with: ["1941", "2901", "2911"],
});
export const HWIC_8A = new ModuleSpec({
    name: "HWIC-8A", module_type: 2, category: "router_hwic",
    ports_added: Array.from({ length: 8 }, (_, i) => `Async0/0/${i}`),
    description: "8-port Async Serial",
    compatible_with: ["1941", "2901", "2911"],
});
export const HWIC_AP_AG_B = new ModuleSpec({
    name: "HWIC-AP-AG-B", module_type: 2, category: "router_hwic",
    ports_added: [],
    description: "Integrated Wireless AP",
    compatible_with: ["1941", "2901", "2911"],
});
export const NIM_2T = new ModuleSpec({
    name: "NIM-2T", module_type: 2, category: "router_nim",
    ports_added: ["Serial0/1/0", "Serial0/1/1"],
    description: "2-port Serial NIM for ISR 4000",
    compatible_with: ["ISR4321", "ISR4331"],
});
export const NIM_COVER = new ModuleSpec({
    name: "NIM-Cover", module_type: 2, category: "router_nim",
    ports_added: [],
    description: "NIM slot cover plate",
    compatible_with: ["ISR4321", "ISR4331"],
});
export const NIM_ES2_4 = new ModuleSpec({
    name: "NIM-ES2-4", module_type: 2, category: "router_nim",
    ports_added: ["GigabitEthernet0/1/0", "GigabitEthernet0/1/1",
                 "GigabitEthernet0/1/2", "GigabitEthernet0/1/3"],
    description: "4-port GE Layer 2 NIM for ISR 4000",
    compatible_with: ["ISR4321", "ISR4331"],
});
export const WIC_1AM = new ModuleSpec({
    name: "WIC-1AM", module_type: 2, category: "router_wic",
    ports_added: ["Modem0/0/0"],
    description: "1-port Analog Modem WIC",
});
export const WIC_1ENET = new ModuleSpec({
    name: "WIC-1ENET", module_type: 2, category: "router_wic",
    ports_added: ["Ethernet0/0/0"],
    description: "1-port Ethernet WIC",
});
export const WIC_1T = new ModuleSpec({
    name: "WIC-1T", module_type: 2, category: "router_wic",
    ports_added: ["Serial0/0/0"],
    description: "1-port Serial WAN Interface Card",
});
export const WIC_2AM = new ModuleSpec({
    name: "WIC-2AM", module_type: 2, category: "router_wic",
    ports_added: ["Modem0/0/0", "Modem0/0/1"],
    description: "2-port Analog Modem WIC",
});
export const WIC_2T = new ModuleSpec({
    name: "WIC-2T", module_type: 2, category: "router_wic",
    ports_added: ["Serial0/0/0", "Serial0/0/1"],
    description: "2-port Serial WAN Interface Card",
});
export const WIC_COVER = new ModuleSpec({
    name: "WIC-Cover", module_type: 2, category: "router_wic",
    ports_added: [],
    description: "WIC slot cover plate",
});

// =====================================================================
// Type 3 — PT Router NM (Generic Router modules)
// =====================================================================
export const PT_ROUTER_NM_1AM = new ModuleSpec({
    name: "PT-ROUTER-NM-1AM", module_type: 3, category: "pt_router_nm",
    ports_added: ["Modem0/0/0"],
    description: "1-port Analog Modem for PT Router",
});
export const PT_ROUTER_NM_1CE = new ModuleSpec({
    name: "PT-ROUTER-NM-1CE", module_type: 3, category: "pt_router_nm",
    ports_added: ["Ethernet0/0/0"],
    description: "1-port Copper Ethernet for PT Router",
});
export const PT_ROUTER_NM_1CFE = new ModuleSpec({
    name: "PT-ROUTER-NM-1CFE", module_type: 3, category: "pt_router_nm",
    ports_added: ["FastEthernet0/0/0"],
    description: "1-port Copper FastEthernet for PT Router",
});
export const PT_ROUTER_NM_1CGE = new ModuleSpec({
    name: "PT-ROUTER-NM-1CGE", module_type: 3, category: "pt_router_nm",
    ports_added: ["GigabitEthernet0/0/0"],
    description: "1-port Copper GigabitEthernet for PT Router",
});
export const PT_ROUTER_NM_1FFE = new ModuleSpec({
    name: "PT-ROUTER-NM-1FFE", module_type: 3, category: "pt_router_nm",
    ports_added: ["FastEthernet0/0/0"],
    description: "1-port Fiber FastEthernet for PT Router",
});
export const PT_ROUTER_NM_1FGE = new ModuleSpec({
    name: "PT-ROUTER-NM-1FGE", module_type: 3, category: "pt_router_nm",
    ports_added: ["GigabitEthernet0/0/0"],
    description: "1-port Fiber GigabitEthernet for PT Router",
});
export const PT_ROUTER_NM_1S = new ModuleSpec({
    name: "PT-ROUTER-NM-1S", module_type: 3, category: "pt_router_nm",
    ports_added: ["Serial0/0/0"],
    description: "1-port Serial for PT Router",
});
export const PT_ROUTER_NM_1SS = new ModuleSpec({
    name: "PT-ROUTER-NM-1SS", module_type: 3, category: "pt_router_nm",
    ports_added: ["Serial0/0/0"],
    description: "1-port Smart Serial for PT Router",
});
export const PT_ROUTER_NM_COVER = new ModuleSpec({
    name: "PT-ROUTER-NM-COVER", module_type: 3, category: "pt_router_nm",
    ports_added: [],
    description: "Cover plate for PT Router",
});

// =====================================================================
// Type 4 — PT Switch NM + Power modules
// =====================================================================
export const AC_POWER_SUPPLY = new ModuleSpec({
    name: "AC-POWER-SUPPLY", module_type: 4, category: "pt_switch_nm",
    ports_added: [],
    description: "AC Power Supply",
});
export const POWER_COVER_PLATE = new ModuleSpec({
    name: "POWER-COVER-PLATE", module_type: 4, category: "pt_switch_nm",
    ports_added: [],
    description: "Power Cover Plate",
});
export const PT_SWITCH_NM_1CE = new ModuleSpec({
    name: "PT-SWITCH-NM-1CE", module_type: 4, category: "pt_switch_nm",
    ports_added: ["Ethernet0/0/0"],
    description: "1-port Copper Ethernet for PT Switch",
});
export const PT_SWITCH_NM_1CFE = new ModuleSpec({
    name: "PT-SWITCH-NM-1CFE", module_type: 4, category: "pt_switch_nm",
    ports_added: ["FastEthernet0/0/0"],
    description: "1-port Copper FastEthernet for PT Switch",
});
export const PT_SWITCH_NM_1CGE = new ModuleSpec({
    name: "PT-SWITCH-NM-1CGE", module_type: 4, category: "pt_switch_nm",
    ports_added: ["GigabitEthernet0/0/0"],
    description: "1-port Copper GigabitEthernet for PT Switch",
});
export const PT_SWITCH_NM_1FFE = new ModuleSpec({
    name: "PT-SWITCH-NM-1FFE", module_type: 4, category: "pt_switch_nm",
    ports_added: ["FastEthernet0/0/0"],
    description: "1-port Fiber FastEthernet for PT Switch",
});
export const PT_SWITCH_NM_1FGE = new ModuleSpec({
    name: "PT-SWITCH-NM-1FGE", module_type: 4, category: "pt_switch_nm",
    ports_added: ["GigabitEthernet0/0/0"],
    description: "1-port Fiber GigabitEthernet for PT Switch",
});
export const PT_SWITCH_NM_COVER = new ModuleSpec({
    name: "PT-SWITCH-NM-COVER", module_type: 4, category: "pt_switch_nm",
    ports_added: [],
    description: "Cover plate for PT Switch",
});

// =====================================================================
// Type 5 — PT Cloud NM modules
// =====================================================================
export const PT_CLOUD_NM_1AM = new ModuleSpec({
    name: "PT-CLOUD-NM-1AM", module_type: 5, category: "pt_cloud_nm",
    ports_added: ["Modem0"],
    description: "1-port Analog Modem for PT Cloud",
});
export const PT_CLOUD_NM_1CE = new ModuleSpec({
    name: "PT-CLOUD-NM-1CE", module_type: 5, category: "pt_cloud_nm",
    ports_added: ["Ethernet0"],
    description: "1-port Copper Ethernet for PT Cloud",
});
export const PT_CLOUD_NM_1CFE = new ModuleSpec({
    name: "PT-CLOUD-NM-1CFE", module_type: 5, category: "pt_cloud_nm",
    ports_added: ["FastEthernet0"],
    description: "1-port Copper FastEthernet for PT Cloud",
});
export const PT_CLOUD_NM_1CGE = new ModuleSpec({
    name: "PT-CLOUD-NM-1CGE", module_type: 5, category: "pt_cloud_nm",
    ports_added: ["GigabitEthernet0"],
    description: "1-port Copper GigabitEthernet for PT Cloud",
});
export const PT_CLOUD_NM_1CX = new ModuleSpec({
    name: "PT-CLOUD-NM-1CX", module_type: 5, category: "pt_cloud_nm",
    ports_added: ["Coaxial0"],
    description: "1-port Coaxial for PT Cloud",
});
export const PT_CLOUD_NM_1FFE = new ModuleSpec({
    name: "PT-CLOUD-NM-1FFE", module_type: 5, category: "pt_cloud_nm",
    ports_added: ["FastEthernet0"],
    description: "1-port Fiber FastEthernet for PT Cloud",
});
export const PT_CLOUD_NM_1FGE = new ModuleSpec({
    name: "PT-CLOUD-NM-1FGE", module_type: 5, category: "pt_cloud_nm",
    ports_added: ["GigabitEthernet0"],
    description: "1-port Fiber GigabitEthernet for PT Cloud",
});
export const PT_CLOUD_NM_1S = new ModuleSpec({
    name: "PT-CLOUD-NM-1S", module_type: 5, category: "pt_cloud_nm",
    ports_added: ["Serial0"],
    description: "1-port Serial for PT Cloud",
});

// =====================================================================
// Type 6 — PT Repeater NM modules
// =====================================================================
export const PT_REPEATER_NM_1CE = new ModuleSpec({
    name: "PT-REPEATER-NM-1CE", module_type: 6, category: "pt_repeater_nm",
    ports_added: ["Ethernet0"],
    description: "1-port Copper Ethernet for PT Repeater",
});
export const PT_REPEATER_NM_1CFE = new ModuleSpec({
    name: "PT-REPEATER-NM-1CFE", module_type: 6, category: "pt_repeater_nm",
    ports_added: ["FastEthernet0"],
    description: "1-port Copper FastEthernet for PT Repeater",
});
export const PT_REPEATER_NM_1CGE = new ModuleSpec({
    name: "PT-REPEATER-NM-1CGE", module_type: 6, category: "pt_repeater_nm",
    ports_added: ["GigabitEthernet0"],
    description: "1-port Copper GigabitEthernet for PT Repeater",
});
export const PT_REPEATER_NM_1FFE = new ModuleSpec({
    name: "PT-REPEATER-NM-1FFE", module_type: 6, category: "pt_repeater_nm",
    ports_added: ["FastEthernet0"],
    description: "1-port Fiber FastEthernet for PT Repeater",
});
export const PT_REPEATER_NM_1FGE = new ModuleSpec({
    name: "PT-REPEATER-NM-1FGE", module_type: 6, category: "pt_repeater_nm",
    ports_added: ["GigabitEthernet0"],
    description: "1-port Fiber GigabitEthernet for PT Repeater",
});
export const PT_REPEATER_NM_COVER = new ModuleSpec({
    name: "PT-REPEATER-NM-COVER", module_type: 6, category: "pt_repeater_nm",
    ports_added: [],
    description: "Cover plate for PT Repeater",
});

// =====================================================================
// Type 7 — PT Host NM modules (PC, Server, etc.)
// =====================================================================
export const LINKSYS_WMP300N = new ModuleSpec({
    name: "Linksys-WMP300N", module_type: 7, category: "pt_host_nm",
    ports_added: [],
    description: "Linksys WMP300N Wireless PCI adapter",
});
export const PT_HOST_NM_1AM = new ModuleSpec({
    name: "PT-HOST-NM-1AM", module_type: 7, category: "pt_host_nm",
    ports_added: ["Modem0"],
    description: "1-port Analog Modem for PT Host",
});
export const PT_HOST_NM_1CE = new ModuleSpec({
    name: "PT-HOST-NM-1CE", module_type: 7, category: "pt_host_nm",
    ports_added: ["Ethernet0"],
    description: "1-port Copper Ethernet for PT Host",
});
export const PT_HOST_NM_1CFE = new ModuleSpec({
    name: "PT-HOST-NM-1CFE", module_type: 7, category: "pt_host_nm",
    ports_added: ["FastEthernet0"],
    description: "1-port Copper FastEthernet for PT Host",
});
export const PT_HOST_NM_1CGE = new ModuleSpec({
    name: "PT-HOST-NM-1CGE", module_type: 7, category: "pt_host_nm",
    ports_added: ["GigabitEthernet0"],
    description: "1-port Copper GigabitEthernet for PT Host",
});
export const PT_HOST_NM_1FFE = new ModuleSpec({
    name: "PT-HOST-NM-1FFE", module_type: 7, category: "pt_host_nm",
    ports_added: ["FastEthernet0"],
    description: "1-port Fiber FastEthernet for PT Host",
});
export const PT_HOST_NM_1FGE = new ModuleSpec({
    name: "PT-HOST-NM-1FGE", module_type: 7, category: "pt_host_nm",
    ports_added: ["GigabitEthernet0"],
    description: "1-port Fiber GigabitEthernet for PT Host",
});
export const PT_HOST_NM_1W = new ModuleSpec({
    name: "PT-HOST-NM-1W", module_type: 7, category: "pt_host_nm",
    ports_added: [],
    description: "Wireless adapter for PT Host",
});
export const PT_HOST_NM_1W_A = new ModuleSpec({
    name: "PT-HOST-NM-1W-A", module_type: 7, category: "pt_host_nm",
    ports_added: [],
    description: "Wireless-A adapter for PT Host",
});
export const PT_HOST_NM_1W_AC = new ModuleSpec({
    name: "PT-HOST-NM-1W-AC", module_type: 7, category: "pt_host_nm",
    ports_added: [],
    description: "Wireless-AC adapter for PT Host",
});
export const PT_HOST_NM_3G4G = new ModuleSpec({
    name: "PT-HOST-NM-3G/4G", module_type: 7, category: "pt_host_nm",
    ports_added: [],
    description: "3G/4G cellular adapter for PT Host",
});
export const PT_HOST_NM_COVER = new ModuleSpec({
    name: "PT-HOST-NM-COVER", module_type: 7, category: "pt_host_nm",
    ports_added: [],
    description: "Cover plate for PT Host",
});

// =====================================================================
// Type 8 — PT Modem NM modules
// =====================================================================
export const PT_MODEM_NM_1CE = new ModuleSpec({
    name: "PT-MODEM-NM-1CE", module_type: 8, category: "pt_modem_nm",
    ports_added: ["Ethernet0"],
    description: "1-port Copper Ethernet for PT Modem",
});
export const PT_MODEM_NM_1CFE = new ModuleSpec({
    name: "PT-MODEM-NM-1CFE", module_type: 8, category: "pt_modem_nm",
    ports_added: ["FastEthernet0"],
    description: "1-port Copper FastEthernet for PT Modem",
});
export const PT_MODEM_NM_1CGE = new ModuleSpec({
    name: "PT-MODEM-NM-1CGE", module_type: 8, category: "pt_modem_nm",
    ports_added: ["GigabitEthernet0"],
    description: "1-port Copper GigabitEthernet for PT Modem",
});

// =====================================================================
// Type 9 — PT Laptop NM modules
// =====================================================================
export const LINKSYS_WPC300N_LAPTOP = new ModuleSpec({
    name: "Linksys-WPC300N", module_type: 9, category: "pt_laptop_nm",
    ports_added: [],
    description: "Linksys WPC300N Wireless PCMCIA for Laptop",
});
export const PT_LAPTOP_NM_1AM = new ModuleSpec({
    name: "PT-LAPTOP-NM-1AM", module_type: 9, category: "pt_laptop_nm",
    ports_added: ["Modem0"],
    description: "1-port Analog Modem for PT Laptop",
});
export const PT_LAPTOP_NM_1CE = new ModuleSpec({
    name: "PT-LAPTOP-NM-1CE", module_type: 9, category: "pt_laptop_nm",
    ports_added: ["Ethernet0"],
    description: "1-port Copper Ethernet for PT Laptop",
});
export const PT_LAPTOP_NM_1CFE = new ModuleSpec({
    name: "PT-LAPTOP-NM-1CFE", module_type: 9, category: "pt_laptop_nm",
    ports_added: ["FastEthernet0"],
    description: "1-port Copper FastEthernet for PT Laptop",
});
export const PT_LAPTOP_NM_1CGE = new ModuleSpec({
    name: "PT-LAPTOP-NM-1CGE", module_type: 9, category: "pt_laptop_nm",
    ports_added: ["GigabitEthernet0"],
    description: "1-port Copper GigabitEthernet for PT Laptop",
});
export const PT_LAPTOP_NM_1FFE = new ModuleSpec({
    name: "PT-LAPTOP-NM-1FFE", module_type: 9, category: "pt_laptop_nm",
    ports_added: ["FastEthernet0"],
    description: "1-port Fiber FastEthernet for PT Laptop",
});
export const PT_LAPTOP_NM_1FGE = new ModuleSpec({
    name: "PT-LAPTOP-NM-1FGE", module_type: 9, category: "pt_laptop_nm",
    ports_added: ["GigabitEthernet0"],
    description: "1-port Fiber GigabitEthernet for PT Laptop",
});
export const PT_LAPTOP_NM_1W = new ModuleSpec({
    name: "PT-LAPTOP-NM-1W", module_type: 9, category: "pt_laptop_nm",
    ports_added: [],
    description: "Wireless adapter for PT Laptop",
});
export const PT_LAPTOP_NM_1W_A = new ModuleSpec({
    name: "PT-LAPTOP-NM-1W-A", module_type: 9, category: "pt_laptop_nm",
    ports_added: [],
    description: "Wireless-A adapter for PT Laptop",
});
export const PT_LAPTOP_NM_1W_AC = new ModuleSpec({
    name: "PT-LAPTOP-NM-1W-AC", module_type: 9, category: "pt_laptop_nm",
    ports_added: [],
    description: "Wireless-AC adapter for PT Laptop",
});
export const PT_LAPTOP_NM_3G4G = new ModuleSpec({
    name: "PT-LAPTOP-NM-3G/4G", module_type: 9, category: "pt_laptop_nm",
    ports_added: [],
    description: "3G/4G cellular adapter for PT Laptop",
});

// =====================================================================
// Type 10 — PT Cloud NM Coaxial (duplicate key in allModuleTypes)
// =====================================================================
export const PT_CLOUD_NM_1CX_TYPE10 = new ModuleSpec({
    name: "PT-CLOUD-NM-1CX", module_type: 10, category: "pt_cloud_nm",
    ports_added: ["Coaxial0"],
    description: "1-port Coaxial for PT Cloud (type 10)",
});

// =====================================================================
// Type 11 — IP Phone Power Adapter
// =====================================================================
export const IP_PHONE_POWER_ADAPTER = new ModuleSpec({
    name: "IP_PHONE_POWER_ADAPTER", module_type: 11, category: "ip_phone",
    ports_added: [],
    description: "Power adapter for IP Phone",
});

// =====================================================================
// Type 12 — PT TabletPC NM modules
// =====================================================================
export const PT_TABLETPC_NM_1AM = new ModuleSpec({
    name: "PT-TABLETPC-NM-1AM", module_type: 12, category: "pt_tabletpc_nm",
    ports_added: ["Modem0"],
    description: "1-port Analog Modem for TabletPC",
});
export const PT_TABLETPC_NM_1CE = new ModuleSpec({
    name: "PT-TABLETPC-NM-1CE", module_type: 12, category: "pt_tabletpc_nm",
    ports_added: ["Ethernet0"],
    description: "1-port Copper Ethernet for TabletPC",
});
export const PT_TABLETPC_NM_1CFE = new ModuleSpec({
    name: "PT-TABLETPC-NM-1CFE", module_type: 12, category: "pt_tabletpc_nm",
    ports_added: ["FastEthernet0"],
    description: "1-port Copper FastEthernet for TabletPC",
});
export const PT_TABLETPC_NM_1CGE = new ModuleSpec({
    name: "PT-TABLETPC-NM-1CGE", module_type: 12, category: "pt_tabletpc_nm",
    ports_added: ["GigabitEthernet0"],
    description: "1-port Copper GigabitEthernet for TabletPC",
});
export const PT_TABLETPC_NM_1FFE = new ModuleSpec({
    name: "PT-TABLETPC-NM-1FFE", module_type: 12, category: "pt_tabletpc_nm",
    ports_added: ["FastEthernet0"],
    description: "1-port Fiber FastEthernet for TabletPC",
});
export const PT_TABLETPC_NM_1FGE = new ModuleSpec({
    name: "PT-TABLETPC-NM-1FGE", module_type: 12, category: "pt_tabletpc_nm",
    ports_added: ["GigabitEthernet0"],
    description: "1-port Fiber GigabitEthernet for TabletPC",
});
export const PT_TABLETPC_NM_1W = new ModuleSpec({
    name: "PT-TABLETPC-NM-1W", module_type: 12, category: "pt_tabletpc_nm",
    ports_added: [],
    description: "Wireless adapter for TabletPC",
});
export const PT_TABLETPC_NM_1W_A = new ModuleSpec({
    name: "PT-TABLETPC-NM-1W-A", module_type: 12, category: "pt_tabletpc_nm",
    ports_added: [],
    description: "Wireless-A adapter for TabletPC",
});
export const PT_TABLETPC_NM_1W_AC = new ModuleSpec({
    name: "PT-TABLETPC-NM-1W-AC", module_type: 12, category: "pt_tabletpc_nm",
    ports_added: [],
    description: "Wireless-AC adapter for TabletPC",
});
export const PT_TABLETPC_NM_3G = new ModuleSpec({
    name: "PT-TABLETPC-NM-3G", module_type: 12, category: "pt_tabletpc_nm",
    ports_added: [],
    description: "3G cellular adapter for TabletPC",
});

// =====================================================================
// Type 13 — PT PDA/Smartphone NM modules
// =====================================================================
export const PT_PDA_NM_1AM = new ModuleSpec({
    name: "PT-PDA-NM-1AM", module_type: 13, category: "pt_pda_nm",
    ports_added: ["Modem0"],
    description: "1-port Analog Modem for PDA/Smartphone",
});
export const PT_PDA_NM_1CE = new ModuleSpec({
    name: "PT-PDA-NM-1CE", module_type: 13, category: "pt_pda_nm",
    ports_added: ["Ethernet0"],
    description: "1-port Copper Ethernet for PDA/Smartphone",
});
export const PT_PDA_NM_1CFE = new ModuleSpec({
    name: "PT-PDA-NM-1CFE", module_type: 13, category: "pt_pda_nm",
    ports_added: ["FastEthernet0"],
    description: "1-port Copper FastEthernet for PDA/Smartphone",
});
export const PT_PDA_NM_1CGE = new ModuleSpec({
    name: "PT-PDA-NM-1CGE", module_type: 13, category: "pt_pda_nm",
    ports_added: ["GigabitEthernet0"],
    description: "1-port Copper GigabitEthernet for PDA/Smartphone",
});
export const PT_PDA_NM_1FFE = new ModuleSpec({
    name: "PT-PDA-NM-1FFE", module_type: 13, category: "pt_pda_nm",
    ports_added: ["FastEthernet0"],
    description: "1-port Fiber FastEthernet for PDA/Smartphone",
});
export const PT_PDA_NM_1FGE = new ModuleSpec({
    name: "PT-PDA-NM-1FGE", module_type: 13, category: "pt_pda_nm",
    ports_added: ["GigabitEthernet0"],
    description: "1-port Fiber GigabitEthernet for PDA/Smartphone",
});
export const PT_PDA_NM_1W = new ModuleSpec({
    name: "PT-PDA-NM-1W", module_type: 13, category: "pt_pda_nm",
    ports_added: [],
    description: "Wireless adapter for PDA/Smartphone",
});
export const PT_PDA_NM_1W_A = new ModuleSpec({
    name: "PT-PDA-NM-1W-A", module_type: 13, category: "pt_pda_nm",
    ports_added: [],
    description: "Wireless-A adapter for PDA/Smartphone",
});
export const PT_PDA_NM_1W_AC = new ModuleSpec({
    name: "PT-PDA-NM-1W-AC", module_type: 13, category: "pt_pda_nm",
    ports_added: [],
    description: "Wireless-AC adapter for PDA/Smartphone",
});
export const PT_PDA_NM_3G4G = new ModuleSpec({
    name: "PT-PDA-NM-3G/4G", module_type: 13, category: "pt_pda_nm",
    ports_added: [],
    description: "3G/4G cellular adapter for PDA/Smartphone",
});

// =====================================================================
// Type 14 — PT Wireless End Device NM modules
// =====================================================================
export const PT_WIRELESSEND_NM_1CE = new ModuleSpec({
    name: "PT-WIRELESSENDDEVICE-NM-1CE", module_type: 14, category: "pt_wirelessend_nm",
    ports_added: ["Ethernet0"],
    description: "1-port Copper Ethernet for Wireless End Device",
});
export const PT_WIRELESSEND_NM_1CFE = new ModuleSpec({
    name: "PT-WIRELESSENDDEVICE-NM-1CFE", module_type: 14, category: "pt_wirelessend_nm",
    ports_added: ["FastEthernet0"],
    description: "1-port Copper FastEthernet for Wireless End Device",
});
export const PT_WIRELESSEND_NM_1CGE = new ModuleSpec({
    name: "PT-WIRELESSENDDEVICE-NM-1CGE", module_type: 14, category: "pt_wirelessend_nm",
    ports_added: ["GigabitEthernet0"],
    description: "1-port Copper GigabitEthernet for Wireless End Device",
});
export const PT_WIRELESSEND_NM_1FFE = new ModuleSpec({
    name: "PT-WIRELESSENDDEVICE-NM-1FFE", module_type: 14, category: "pt_wirelessend_nm",
    ports_added: ["FastEthernet0"],
    description: "1-port Fiber FastEthernet for Wireless End Device",
});
export const PT_WIRELESSEND_NM_1FGE = new ModuleSpec({
    name: "PT-WIRELESSENDDEVICE-NM-1FGE", module_type: 14, category: "pt_wirelessend_nm",
    ports_added: ["GigabitEthernet0"],
    description: "1-port Fiber GigabitEthernet for Wireless End Device",
});
export const PT_WIRELESSEND_NM_1W = new ModuleSpec({
    name: "PT-WIRELESSENDDEVICE-NM-1W", module_type: 14, category: "pt_wirelessend_nm",
    ports_added: [],
    description: "Wireless adapter for Wireless End Device",
});
export const PT_WIRELESSEND_NM_1W_A = new ModuleSpec({
    name: "PT-WIRELESSENDDEVICE-NM-1W-A", module_type: 14, category: "pt_wirelessend_nm",
    ports_added: [],
    description: "Wireless-A adapter for Wireless End Device",
});
export const PT_WIRELESSEND_NM_1W_AC = new ModuleSpec({
    name: "PT-WIRELESSENDDEVICE-NM-1W-AC", module_type: 14, category: "pt_wirelessend_nm",
    ports_added: [],
    description: "Wireless-AC adapter for Wireless End Device",
});

// =====================================================================
// Type 15 — PT Wired End Device NM modules
// =====================================================================
export const PT_WIREDEND_NM_1CE = new ModuleSpec({
    name: "PT-WIREDENDDEVICE-NM-1CE", module_type: 15, category: "pt_wiredend_nm",
    ports_added: ["Ethernet0"],
    description: "1-port Copper Ethernet for Wired End Device",
});
export const PT_WIREDEND_NM_1CFE = new ModuleSpec({
    name: "PT-WIREDENDDEVICE-NM-1CFE", module_type: 15, category: "pt_wiredend_nm",
    ports_added: ["FastEthernet0"],
    description: "1-port Copper FastEthernet for Wired End Device",
});
export const PT_WIREDEND_NM_1CGE = new ModuleSpec({
    name: "PT-WIREDENDDEVICE-NM-1CGE", module_type: 15, category: "pt_wiredend_nm",
    ports_added: ["GigabitEthernet0"],
    description: "1-port Copper GigabitEthernet for Wired End Device",
});
export const PT_WIREDEND_NM_1FFE = new ModuleSpec({
    name: "PT-WIREDENDDEVICE-NM-1FFE", module_type: 15, category: "pt_wiredend_nm",
    ports_added: ["FastEthernet0"],
    description: "1-port Fiber FastEthernet for Wired End Device",
});
export const PT_WIREDEND_NM_1FGE = new ModuleSpec({
    name: "PT-WIREDENDDEVICE-NM-1FGE", module_type: 15, category: "pt_wiredend_nm",
    ports_added: ["GigabitEthernet0"],
    description: "1-port Fiber GigabitEthernet for Wired End Device",
});
export const PT_WIREDEND_NM_1W = new ModuleSpec({
    name: "PT-WIREDENDDEVICE-NM-1W", module_type: 15, category: "pt_wiredend_nm",
    ports_added: [],
    description: "Wireless adapter for Wired End Device",
});
export const PT_WIREDEND_NM_1W_A = new ModuleSpec({
    name: "PT-WIREDENDDEVICE-NM-1W-A", module_type: 15, category: "pt_wiredend_nm",
    ports_added: [],
    description: "Wireless-A adapter for Wired End Device",
});

// =====================================================================
// Type 16 — PT Audio modules (Headphone, Microphone)
// =====================================================================
export const PT_HEADPHONE = new ModuleSpec({
    name: "PT-HEADPHONE", module_type: 16, category: "pt_audio",
    ports_added: [],
    description: "Headphone module",
});
export const PT_MICROPHONE = new ModuleSpec({
    name: "PT-MICROPHONE", module_type: 16, category: "pt_audio",
    ports_added: [],
    description: "Microphone module",
});

// =====================================================================
// Type 19 — ASA Cover
// =====================================================================
export const ASA_COVER = new ModuleSpec({
    name: "ASA-Cover", module_type: 19, category: "asa",
    ports_added: [],
    description: "ASA slot cover plate",
});

// =====================================================================
// Type 21 — Cell Tower NM modules
// =====================================================================
export const PT_CELL_NM_1CX = new ModuleSpec({
    name: "PT-CELL-NM-1CX", module_type: 21, category: "pt_cell_nm",
    ports_added: ["Coaxial0"],
    description: "1-port Coaxial for Cell Tower",
});
export const PT_CELL_NM_3G4G = new ModuleSpec({
    name: "PT-CELL-NM-3G/4G", module_type: 21, category: "pt_cell_nm",
    ports_added: [],
    description: "3G/4G cellular for Cell Tower",
});

// =====================================================================
// Type 23 — PT IoT NM modules (22 is refused by PT 9.0.1: measured 2026-10-25)
// =====================================================================
export const PT_IOT_NM_1CE_T22 = new ModuleSpec({
    name: "PT-IOT-NM-1CE", module_type: 23, category: "pt_iot_nm",
    ports_added: ["Ethernet0"],
    description: "1-port Copper Ethernet for IoT (type 22)",
});
export const PT_IOT_NM_1CFE_T22 = new ModuleSpec({
    name: "PT-IOT-NM-1CFE", module_type: 23, category: "pt_iot_nm",
    ports_added: ["FastEthernet0"],
    description: "1-port Copper FastEthernet for IoT (type 22)",
});
export const PT_IOT_NM_1CGE_T22 = new ModuleSpec({
    name: "PT-IOT-NM-1CGE", module_type: 23, category: "pt_iot_nm",
    ports_added: ["GigabitEthernet0"],
    description: "1-port Copper GigabitEthernet for IoT (type 22)",
});
export const PT_IOT_NM_1W_T22 = new ModuleSpec({
    name: "PT-IOT-NM-1W", module_type: 23, category: "pt_iot_nm",
    ports_added: [],
    description: "Wireless adapter for IoT (type 22)",
});
// Type 23 variants (Thing/IoT extended)
export const PT_IOT_NM_1W_AC_T23 = new ModuleSpec({
    name: "PT-IOT-NM-1W-AC", module_type: 23, category: "pt_iot_nm",
    ports_added: [],
    description: "Wireless-AC adapter for IoT Thing",
});
export const PT_IOT_NM_3G4G_T23 = new ModuleSpec({
    name: "PT-IOT-NM-3G/4G", module_type: 23, category: "pt_iot_nm",
    ports_added: [],
    description: "3G/4G cellular for IoT Thing",
});

// =====================================================================
// Type 26-28 — IoT Custom I/O, Power adapters
// =====================================================================
export const PT_IOT_CUSTOM_IO = new ModuleSpec({
    name: "PT-IOT-CUSTOM-IO", module_type: 26, category: "pt_iot_nm",
    ports_added: [],
    description: "Custom I/O module for IoT",
});
export const PT_IOT_POWER_ADAPTER = new ModuleSpec({
    name: "PT-IOT-POWER-ADAPTER", module_type: 27, category: "pt_iot_nm",
    ports_added: [],
    description: "Power adapter for IoT",
});
export const PT_UNV_PWR_ADAPTER = new ModuleSpec({
    name: "PT-UNV-PWR-ADAPTER", module_type: 28, category: "pt_universal",
    ports_added: [],
    description: "Universal power adapter",
});

// =====================================================================
// Type 29 — Router Adapter
// =====================================================================
export const ROUTER_ADAPTER = new ModuleSpec({
    name: "ROUTER-ADAPTER", module_type: 29, category: "router_adapter",
    ports_added: [],
    description: "Router adapter",
});

// =====================================================================
// Type 30 — SFP Modules (GLC)
// =====================================================================
export const GLC_FE_100FX_RGD = new ModuleSpec({
    name: "GLC-FE-100FX-RGD", module_type: 30, category: "sfp",
    ports_added: [],
    description: "100BASE-FX SFP (rugged)",
});
export const GLC_GE_100FX = new ModuleSpec({
    name: "GLC-GE-100FX", module_type: 30, category: "sfp",
    ports_added: [],
    description: "100BASE-FX SFP for GE port",
});
export const GLC_LH_SMD = new ModuleSpec({
    name: "GLC-LH-SMD", module_type: 30, category: "sfp",
    ports_added: [],
    description: "1000BASE-LX/LH SFP (long haul)",
});
export const GLC_T = new ModuleSpec({
    name: "GLC-T", module_type: 30, category: "sfp",
    ports_added: [],
    description: "1000BASE-T SFP (copper)",
});
export const GLC_TE = new ModuleSpec({
    name: "GLC-TE", module_type: 30, category: "sfp",
    ports_added: [],
    description: "1000BASE-T SFP Extended",
});

// =====================================================================
// Type 31 — Access Point Power Adapter
// =====================================================================
export const ACCESS_POINT_POWER_ADAPTER = new ModuleSpec({
    name: "ACCESS_POINT_POWER_ADAPTER", module_type: 31, category: "accesspoint",
    ports_added: [],
    description: "Power adapter for Access Point",
});

// =====================================================================
// Type 32 — Built-in modules (factory modules)
// =====================================================================
export const C3650_BUILTIN = new ModuleSpec({
    name: "C3650-BUILTIN", module_type: 32, category: "builtin",
    ports_added: [],
    description: "Factory built-in module for 3650",
    compatible_with: ["3650-24PS"],
});
export const C3650_SFP_BUILTIN = new ModuleSpec({
    name: "C3650-SFP-BUILTIN", module_type: 32, category: "builtin",
    ports_added: [],
    description: "Factory SFP built-in module for 3650",
    compatible_with: ["3650-24PS"],
});
export const ISR4321_BUILTIN = new ModuleSpec({
    name: "ISR4321-BUILTIN", module_type: 32, category: "builtin",
    ports_added: [],
    description: "Factory built-in module for ISR4321",
    compatible_with: ["ISR4321"],
});
export const ISR4331_BUILTIN = new ModuleSpec({
    name: "ISR4331-BUILTIN", module_type: 32, category: "builtin",
    ports_added: [],
    description: "Factory built-in module for ISR4331",
    compatible_with: ["ISR4331"],
});
export const PT_CONTROLLER_BUILTIN = new ModuleSpec({
    name: "PT-CONTROLLER-BUILTIN", module_type: 32, category: "builtin",
    ports_added: [],
    description: "Factory built-in module for Network Controller",
});

// =====================================================================
// Type 34 — Meraki Power Adapter
// =====================================================================
export const MERAKI_POWER_ADAPTER = new ModuleSpec({
    name: "MERAKI-POWER-ADAPTER", module_type: 34, category: "meraki",
    ports_added: [],
    description: "Power adapter for Meraki devices",
});


// =====================================================================
// INDEXED CATALOG
// =====================================================================
export const ALL_MODULES = (() => {
    const out = {};
    for (const m of [
        // Type 1 — Router NM
        NM_1E, NM_1E2W, NM_1FE_FX, NM_1FE_TX, NM_1FE2W,
        NM_2E2W, NM_2FE2W, NM_2W, NM_4A_S, NM_4E,
        NM_8A_S, NM_8AM, NM_COVER, NM_ESW_161,
        // Type 2 — Router HWIC/WIC/NIM
        CELLULAR_1240, COVER_1240,
        HWIC_1GE_SFP, HWIC_2T, HWIC_4ESW, HWIC_8A, HWIC_AP_AG_B,
        NIM_2T, NIM_COVER, NIM_ES2_4,
        WIC_1AM, WIC_1ENET, WIC_1T, WIC_2AM, WIC_2T, WIC_COVER,
        // Type 3 — PT Router NM
        PT_ROUTER_NM_1AM, PT_ROUTER_NM_1CE, PT_ROUTER_NM_1CFE,
        PT_ROUTER_NM_1CGE, PT_ROUTER_NM_1FFE, PT_ROUTER_NM_1FGE,
        PT_ROUTER_NM_1S, PT_ROUTER_NM_1SS, PT_ROUTER_NM_COVER,
        // Type 4 — PT Switch NM + Power
        AC_POWER_SUPPLY, POWER_COVER_PLATE,
        PT_SWITCH_NM_1CE, PT_SWITCH_NM_1CFE, PT_SWITCH_NM_1CGE,
        PT_SWITCH_NM_1FFE, PT_SWITCH_NM_1FGE, PT_SWITCH_NM_COVER,
        // Type 5 — PT Cloud NM
        PT_CLOUD_NM_1AM, PT_CLOUD_NM_1CE, PT_CLOUD_NM_1CFE,
        PT_CLOUD_NM_1CGE, PT_CLOUD_NM_1CX, PT_CLOUD_NM_1FFE,
        PT_CLOUD_NM_1FGE, PT_CLOUD_NM_1S,
        // Type 6 — PT Repeater NM
        PT_REPEATER_NM_1CE, PT_REPEATER_NM_1CFE, PT_REPEATER_NM_1CGE,
        PT_REPEATER_NM_1FFE, PT_REPEATER_NM_1FGE, PT_REPEATER_NM_COVER,
        // Type 7 — PT Host NM
        LINKSYS_WMP300N,
        PT_HOST_NM_1AM, PT_HOST_NM_1CE, PT_HOST_NM_1CFE,
        PT_HOST_NM_1CGE, PT_HOST_NM_1FFE, PT_HOST_NM_1FGE,
        PT_HOST_NM_1W, PT_HOST_NM_1W_A, PT_HOST_NM_1W_AC,
        PT_HOST_NM_3G4G, PT_HOST_NM_COVER,
        // Type 8 — PT Modem NM
        PT_MODEM_NM_1CE, PT_MODEM_NM_1CFE, PT_MODEM_NM_1CGE,
        // Type 9 — PT Laptop NM
        LINKSYS_WPC300N_LAPTOP,
        PT_LAPTOP_NM_1AM, PT_LAPTOP_NM_1CE, PT_LAPTOP_NM_1CFE,
        PT_LAPTOP_NM_1CGE, PT_LAPTOP_NM_1FFE, PT_LAPTOP_NM_1FGE,
        PT_LAPTOP_NM_1W, PT_LAPTOP_NM_1W_A, PT_LAPTOP_NM_1W_AC,
        PT_LAPTOP_NM_3G4G,
        // Type 10 — Cloud Coaxial
        PT_CLOUD_NM_1CX_TYPE10,
        // Type 11 — IP Phone Power
        IP_PHONE_POWER_ADAPTER,
        // Type 12 — Tablet NM
        PT_TABLETPC_NM_1AM, PT_TABLETPC_NM_1CE, PT_TABLETPC_NM_1CFE,
        PT_TABLETPC_NM_1CGE, PT_TABLETPC_NM_1FFE, PT_TABLETPC_NM_1FGE,
        PT_TABLETPC_NM_1W, PT_TABLETPC_NM_1W_A, PT_TABLETPC_NM_1W_AC,
        PT_TABLETPC_NM_3G,
        // Type 13 — PDA/Smartphone NM
        PT_PDA_NM_1AM, PT_PDA_NM_1CE, PT_PDA_NM_1CFE,
        PT_PDA_NM_1CGE, PT_PDA_NM_1FFE, PT_PDA_NM_1FGE,
        PT_PDA_NM_1W, PT_PDA_NM_1W_A, PT_PDA_NM_1W_AC,
        PT_PDA_NM_3G4G,
        // Type 14 — Wireless End Device NM
        PT_WIRELESSEND_NM_1CE, PT_WIRELESSEND_NM_1CFE, PT_WIRELESSEND_NM_1CGE,
        PT_WIRELESSEND_NM_1FFE, PT_WIRELESSEND_NM_1FGE,
        PT_WIRELESSEND_NM_1W, PT_WIRELESSEND_NM_1W_A, PT_WIRELESSEND_NM_1W_AC,
        // Type 15 — Wired End Device NM
        PT_WIREDEND_NM_1CE, PT_WIREDEND_NM_1CFE, PT_WIREDEND_NM_1CGE,
        PT_WIREDEND_NM_1FFE, PT_WIREDEND_NM_1FGE,
        PT_WIREDEND_NM_1W, PT_WIREDEND_NM_1W_A,
        // Type 16 — Audio
        PT_HEADPHONE, PT_MICROPHONE,
        // Type 19 — ASA
        ASA_COVER,
        // Type 21 — Cell Tower
        PT_CELL_NM_1CX, PT_CELL_NM_3G4G,
        // Type 22-23 — IoT
        PT_IOT_NM_1CE_T22, PT_IOT_NM_1CFE_T22, PT_IOT_NM_1CGE_T22, PT_IOT_NM_1W_T22,
        PT_IOT_NM_1W_AC_T23, PT_IOT_NM_3G4G_T23,
        // Type 26-28 — IoT Custom/Power
        PT_IOT_CUSTOM_IO, PT_IOT_POWER_ADAPTER, PT_UNV_PWR_ADAPTER,
        // Type 29 — Router Adapter
        ROUTER_ADAPTER,
        // Type 30 — SFP
        GLC_FE_100FX_RGD, GLC_GE_100FX, GLC_LH_SMD, GLC_T, GLC_TE,
        // Type 31 — AP Power
        ACCESS_POINT_POWER_ADAPTER,
        // Type 32 — Built-in
        C3650_BUILTIN, C3650_SFP_BUILTIN,
        ISR4321_BUILTIN, ISR4331_BUILTIN, PT_CONTROLLER_BUILTIN,
        // Type 34 — Meraki Power
        MERAKI_POWER_ADAPTER,
    ]) {
        out[m.name] = m;
    }
    return out;
})();

// Most common modules by use case
export const SERIAL_MODULES = {
    // router pt_type → module that adds serial
    "1941":    "HWIC-2T",
    "2901":    "HWIC-2T",
    "2911":    "HWIC-2T",
    "ISR4321": "NIM-2T",
    "ISR4331": "NIM-2T",
};


export function get_serial_module(router_model) {
    /** Returns the appropriate serial module for a router model. */
    const module_name = Object.prototype.hasOwnProperty.call(SERIAL_MODULES, router_model)
        ? SERIAL_MODULES[router_model] : undefined;
    if (module_name) {
        return Object.prototype.hasOwnProperty.call(ALL_MODULES, module_name)
            ? ALL_MODULES[module_name] : null;
    }
    return null;
}


export function resolve_module(name) {
    /** Resolves a module name. */
    return (Object.prototype.hasOwnProperty.call(ALL_MODULES, name) ? ALL_MODULES[name] : null)
        || (Object.prototype.hasOwnProperty.call(ALL_MODULES, name.toUpperCase()) ? ALL_MODULES[name.toUpperCase()] : null);
}


// Port name such as `Serial0/0/1`: alphabetic prefix + chassis/subslot/index.
const _SLOTTED_PORT = /^([A-Za-z]+)(\d+)\/(\d+)\/(\d+)$/;


export function ports_for_slot(spec, slot) {
    /** Ports that `spec` adds when installed in `slot`.
     *
     * `ModuleSpec.ports_added` lists them for the FIRST slot of the family
     * (an HWIC-2T says `Serial0/0/0`, `Serial0/0/1`), but the real name carries the
     * slot inside it: the same module in `"0/1"` gives `Serial0/1/0` and `Serial0/1/1`.
     * Returning the catalog list as-is made a batch report ports that do not exist,
     * and cabling to that name fails.
     *
     * Only ports shaped `Type<chassis>/<subslot>/<idx>` are rewritten, and only when the
     * slot comes as `"chassis/subslot"` (HWIC, NIM). An NM slot (`"1"`) has no subslot
     * and its ports already come out right from the catalog.
     */
    const slot_s = String(slot).trim();
    if (!slot_s.includes("/")) {
        return [...spec.ports_added];
    }

    const slash = slot_s.indexOf("/");
    const chassis = slot_s.slice(0, slash);
    const subslot = slot_s.slice(slash + 1);
    if (!(/^\d+$/.test(chassis) && /^\d+$/.test(subslot))) {
        return [...spec.ports_added];
    }

    const out = [];
    for (const port of spec.ports_added) {
        const m = _SLOTTED_PORT.exec(port);
        out.push(m ? `${m[1]}${chassis}/${subslot}/${m[4]}` : port);
    }
    return out;
}
