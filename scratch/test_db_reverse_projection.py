from database import latlon_to_utm32n

# Let's test conversion
lat, lon = 53.579631035752335, 8.138661207068754
x, y = latlon_to_utm32n(lat, lon)
print(f"UTM Conversion: X={x:.3f}, Y={y:.3f}")
assert abs(x - 442972.981) < 0.01
assert abs(y - 5937097.795) < 0.01
print("Assertion Passed: High-precision reverse coordinate calculation matches database coordinates!")
