// Load ByteBuffer
var ByteBuffer;
if (typeof dcodeIO !== 'undefined') {
	ByteBuffer = dcodeIO.ByteBuffer;
} else {
	ByteBuffer = require('bytebuffer');
}

var DataType = {
	"End": 0x00, // end of an object or array
	"Object": 0x01, // read named values (names prefixed to value as varint-prefixed UTF-8 string) until you hit End
	"Array": 0x02, // read ordered values until you hit End
	"String": 0x03, // varint-prefixed UTF-8 string
	"Boolean": 0x04, // encoded as byte 0/1
	"Null": 0x05, // no actual data follows
	"PositiveVarInt64": 0x06, // LET THE NUMBER TYPES BEGIN!
	"NegativeVarInt64": 0x07,
	"PositiveInt8": 0x08, // Use Int8 if 0 <= abs(x) < 128. Max uint8 = 255
	"NegativeInt8": 0x09,
	"PositiveInt16": 0x0A, // Use Int16 if 128 <= abs(x) < 16384. Max uint16 = 65535
	"NegativeInt16": 0x0B,
	"PositiveInt32": 0x0C, // Use Int32 if 16384 <= abs(x) < 268435456. Max uint32 = 4294967295
	"NegativeInt32": 0x0D,
	"PositiveInt64": 0x0E, // Use Int64 if abs(x) >= 36028797018963970 (approximately). Use varint64 if 4294967296 <= abs(x) < 36028797018963970
	"NegativeInt64": 0x0F,
	"Double": 0x10
};

exports.decode = function(input) {
	var buffer = ByteBuffer.wrap(input, "binary", false);
	var currentKeyName;
	return readValue();

	function readValue(named) {
		var type = buffer.readUint8();
		var data, val;
		var negative = type % 2 == 1 ? -1 : 1; // all our negative types are odd

		if (type == DataType.End) {
			return undefined; // special value to represent End; JSON can't encode undefined so this isn't a real value
		}

		if (named) {
			currentKeyName = buffer.readVString();
		}

		switch (type) {
			case DataType.Object:
				data = {};
				while ((val = readValue(true)) !== undefined) {
					data[currentKeyName] = val;
				}

				break;

			case DataType.Array:
				data = [];
				while ((val = readValue()) !== undefined) {
					data.push(val);
				}

				break;

			case DataType.String:
				data = buffer.readVString();
				break;

			case DataType.Boolean:
				data = !!buffer.readUint8();
				break;

			case DataType.Null:
				data = null;
				break;

			case DataType.PositiveVarInt64:
			case DataType.NegativeVarInt64:
				data = buffer.readVarint64() * negative;
				break;

			case DataType.PositiveInt8:
			case DataType.NegativeInt8:
				data = buffer.readUint8() * negative;
				break;

			case DataType.PositiveInt16:
			case DataType.NegativeInt16:
				data = buffer.readUint16() * negative;
				break;

			case DataType.PositiveInt32:
			case DataType.NegativeInt32:
				data = buffer.readUint32() * negative;
				break;

			case DataType.PositiveInt64:
			case DataType.NegativeInt64:
				data = buffer.readUint64();
				if (data.compare(Math.pow(2, 53)) <= 0) {
					// If this can be represented accurately as a number, do it
					data = data.toNumber() * negative;
				} else if (negative == -1) {
					data = data.negate().toString();
				} else {
					data = data.toString();
				}

				break;

			case DataType.Double:
				data = buffer.readDouble();
				break;
		}

		return data;
	}
};
