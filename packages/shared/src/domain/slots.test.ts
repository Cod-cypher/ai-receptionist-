import { describe, expect, it } from 'vitest';
import { describeVehicle, nextUnsatisfiedRequirement, validateSlots } from './slots';

describe('describeVehicle', () => {
  it('uses the make and model when both are known', () => {
    expect(describeVehicle({ vehicleMake: 'Toyota', vehicleModel: 'Corolla' })).toBe(
      'Toyota Corolla',
    );
  });

  it('drops a generic type that adds nothing to a known make and model', () => {
    // "Toyota Corolla (Car)" tells a tow operator nothing they cannot see.
    expect(
      describeVehicle({
        vehicleMake: 'Toyota',
        vehicleModel: 'Corolla',
        vehicleType: 'Car',
      }),
    ).toBe('Toyota Corolla');
  });

  it('keeps a type that changes which truck is sent', () => {
    expect(
      describeVehicle({
        vehicleMake: 'Toyota',
        vehicleModel: 'Hilux',
        vehicleType: 'Pickup',
      }),
    ).toBe('Toyota Hilux (Pickup)');
  });

  it('does not repeat a type already present in the model name', () => {
    expect(
      describeVehicle({
        vehicleMake: 'Honda',
        vehicleModel: 'Civic Hatchback',
        vehicleType: 'Hatchback',
      }),
    ).toBe('Honda Civic Hatchback');
  });

  it('falls back to the type alone when there is no make or model', () => {
    expect(describeVehicle({ vehicleType: 'Motorcycle' })).toBe('Motorcycle');
    expect(describeVehicle({})).toBeNull();
  });
});

describe('requirement ordering', () => {
  /**
   * Note this walks the raw slot-level ordering, with nothing pre-filled, so
   * the phone is asked for like any other field. On a real call the caller ID
   * seeds it and the state machine asks the caller to *confirm* it instead —
   * that distinction lives in the state machine, not here.
   */
  it('asks for service, location, vehicle, movability, name, then phone', () => {
    const asked: string[] = [];
    const values: Record<string, unknown> = {};

    const answers: Record<string, Record<string, unknown>> = {
      serviceType: { serviceType: 'towing' },
      location: { location: 'Mall Road' },
      vehicle: { vehicleType: 'car' },
      vehicleMovable: { vehicleMovable: false },
      customerName: { customerName: 'Ahmed' },
      customerPhone: { customerPhone: '+923001234567' },
    };

    for (let i = 0; i < 8; i += 1) {
      const next = nextUnsatisfiedRequirement(values);
      if (!next) break;
      asked.push(next.id);
      Object.assign(values, validateSlots(answers[next.id] as never).accepted);
    }

    expect(asked).toEqual([
      'serviceType',
      'location',
      'vehicle',
      'vehicleMovable',
      'customerName',
      'customerPhone',
    ]);
  });
});
