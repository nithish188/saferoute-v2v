"""
Spatial Neighbour Search using 2D Grid Index
Implements Section IV-D of IEEE paper:
- Grid cells with side length Rs = 300 m
- Vehicle checked against 3x3 neighbourhood (own cell + 8 adjacent cells)
- Filters out parked or slow vehicles where speed < vmin = 2 m/s
"""

import math
from typing import Dict, List, Set, Tuple, Optional
from backend.config import NEIGHBOUR_RADIUS_RS, MINIMUM_MOVING_SPEED_VMIN
from backend.models import VehicleState

class SpatialGridIndex:
    def __init__(self, cell_size: float = NEIGHBOUR_RADIUS_RS, v_min: float = MINIMUM_MOVING_SPEED_VMIN):
        self.cell_size = cell_size
        self.v_min = v_min
        # cell_coord (ix, iy) -> set of vehicle_ids
        self.grid: Dict[Tuple[int, int], Set[str]] = {}
        # vehicle_id -> (ix, iy)
        self.vehicle_cell: Dict[str, Tuple[int, int]] = {}

    def _get_cell_coords(self, x: float, y: float) -> Tuple[int, int]:
        ix = int(math.floor(x / self.cell_size))
        iy = int(math.floor(y / self.cell_size))
        return ix, iy

    def clear(self):
        self.grid.clear()
        self.vehicle_cell.clear()

    def update_vehicle(self, vehicle: VehicleState):
        """Update or insert a vehicle into the spatial grid."""
        # Remove from previous cell if moved
        if vehicle.vehicle_id in self.vehicle_cell:
            old_cell = self.vehicle_cell[vehicle.vehicle_id]
            if old_cell in self.grid and vehicle.vehicle_id in self.grid[old_cell]:
                self.grid[old_cell].remove(vehicle.vehicle_id)

        # Place into new cell
        cell = self._get_cell_coords(vehicle.pos_x, vehicle.pos_y)
        if cell not in self.grid:
            self.grid[cell] = set()
        self.grid[cell].add(vehicle.vehicle_id)
        self.vehicle_cell[vehicle.vehicle_id] = cell

    def remove_vehicle(self, vehicle_id: str):
        if vehicle_id in self.vehicle_cell:
            cell = self.vehicle_cell.pop(vehicle_id)
            if cell in self.grid and vehicle_id in self.grid[cell]:
                self.grid[cell].remove(vehicle_id)

    def get_candidate_pairs(self,
                            vehicles: Dict[str, VehicleState],
                            host_vehicle: Optional[VehicleState] = None,
                            max_radius_from_host: float = 500.0) -> List[Tuple[VehicleState, VehicleState]]:
        """
        Returns pairs (vi, vj) in the same or adjacent 8 grid cells,
        where both vi and vj are active and moving with speed >= v_min.
        If host_vehicle is provided, strictly limits collision prediction
        to vehicles within max_radius_from_host (500m) of host's current location.
        """
        pairs: List[Tuple[VehicleState, VehicleState]] = []
        checked_pairs: Set[Tuple[str, str]] = set()

        for v_id, cell in self.vehicle_cell.items():
            vi = vehicles.get(v_id)
            if not vi or not vi.is_active:
                continue

            # Strict 500m filter from host's current location
            if host_vehicle is not None:
                dist_i = math.sqrt((vi.pos_x - host_vehicle.pos_x)**2 + (vi.pos_y - host_vehicle.pos_y)**2)
                vi.distance_from_host_m = round(dist_i, 1)
                vi.in_analysis_zone = (dist_i <= max_radius_from_host)
                if not vi.in_analysis_zone:
                    continue
            else:
                vi.in_analysis_zone = True

            # Only moving vehicles compared (vmin = 2 m/s)
            # Unless ambulance, which checks against nearby vehicles even if slow
            if vi.speed_smoothed < self.v_min and not vi.ambulance_active:
                continue

            ix, iy = cell
            # Check 3x3 neighbourhood
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    neighbor_cell = (ix + dx, iy + dy)
                    neighbors = self.grid.get(neighbor_cell, set())
                    for neighbor_id in neighbors:
                        if neighbor_id == v_id:
                            continue

                        pair_key = tuple(sorted([v_id, neighbor_id]))
                        if pair_key in checked_pairs:
                            continue
                        checked_pairs.add(pair_key)

                        vj = vehicles.get(neighbor_id)
                        if not vj or not vj.is_active:
                            continue

                        # Strict 500m filter from host's current location for neighbor
                        if host_vehicle is not None:
                            dist_j = math.sqrt((vj.pos_x - host_vehicle.pos_x)**2 + (vj.pos_y - host_vehicle.pos_y)**2)
                            vj.distance_from_host_m = round(dist_j, 1)
                            vj.in_analysis_zone = (dist_j <= max_radius_from_host)
                            if not vj.in_analysis_zone:
                                continue

                        # vj must also satisfy motion criteria unless one is an ambulance
                        if vj.speed_smoothed < self.v_min and not vi.ambulance_active and not vj.ambulance_active:
                            continue

                        pairs.append((vi, vj))

        return pairs

