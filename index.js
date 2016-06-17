// Load ByteBuffer
var ByteBuffer;
if (typeof dcodeIO !== 'undefined') {
	ByteBuffer = dcodeIO.ByteBuffer;
} else {
	ByteBuffer = require('bytebuffer');
}

const MAX_UINT8 = 255;
const MAX_UINT16 = 65535;
const MAX_UINT32 = 4294967295;

var DataType = {
	"End": 0x00, // end of an object or array
	"Object": 0x01, // read named values (names prefixed to value as varint-prefixed UTF-8 string) until you hit End
	"Array": 0x02, // read ordered values until you hit End
	"String": 0x03, // varint-prefixed UTF-8 string
	"BooleanFalse": 0x04, // no sense in wasting a data byte for 1/0
	"BooleanTrue": 0x05,
	"Null": 0x06, // no actual data follows
	"PositiveVarInt64": 0x07, // LET THE NUMBER TYPES BEGIN!
	"NegativeVarInt64": 0x08,
	"PositiveInt8": 0x09,
	"NegativeInt8": 0x0A,
	"PositiveInt16": 0x0B,
	"NegativeInt16": 0x0C,
	"PositiveInt32": 0x0D,
	"NegativeInt32": 0x0E,
	"PositiveInt64": 0x0F,
	"NegativeInt64": 0x10,
	"Double": 0x11,
	"Dictionary": 0x12, // Identical to an array. For internal usage. Stores reused strings.
	"DictionaryEntry": 0x13 // For internal usage. Points to a dictionary entry.
};

exports.decode = function(input) {
	var buffer = ByteBuffer.wrap(input, "binary", false);
	if (buffer.readUint8() == DataType.Dictionary) {
		--buffer.offset;
		var dictionary = readValue()[1];
	} else {
		--buffer.offset;
	}

	return readValue()[1];

	function readValue(named) {
		var type = buffer.readUint8();
		var data, val;
		var negative = type % 2 == 1 ? 1 : -1; // all our negative types are even

		if (type == DataType.End) {
			return undefined; // special value to represent End; JSON can't encode undefined so this isn't a real value
		}

		var currentKeyName;
		if (named) {
			currentKeyName = readValue()[1];
		}

		switch (type) {
			case DataType.Object:
				data = {};
				while ((val = readValue(true)) !== undefined) {
					data[val[0]] = val[1];
				}

				break;

			case DataType.Array:
			case DataType.Dictionary:
				data = [];
				while ((val = readValue()) !== undefined) {
					data.push(val[1]);
				}

				break;

			case DataType.String:
				data = buffer.readVString();
				break;

			case DataType.BooleanFalse:
				data = false;
				break;

			case DataType.BooleanTrue:
				data = true;
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

			case DataType.DictionaryEntry:
				if (!dictionary) {
					throw new Error("Tried to read dictionary entry without a provided dictionary");
				}

				var entry = buffer.readVarint64();
				data = dictionary[entry];
				break;
		}

		return [currentKeyName, data];
	}
};

exports.encode = function(input) {
	var buffer = new ByteBuffer(128, false);
	var dictionary = {};
	// Analyze our input for strings
	analyze(input);

	// We only care about items that appear more than once
	var counter = 0, match;
	for (var i in dictionary) {
		if (!dictionary.hasOwnProperty(i)) {
			continue;
		}

		if (dictionary[i] <= 1) {
			delete dictionary[i];
		} else {
			if (counter == 0) {
				// Go ahead and start the dictionary item
				writeType(DataType.Dictionary);
			}

			match = i.match(/^([^_]+)+_(.*)$/);
			switch (match[1]) {
				case 'str':
					writeType(DataType.String, null, match[2]).writeVString(match[2]);
					break;

				case 'dbl':
					writeType(DataType.Double).writeDouble(parseFloat(match[2]));
					break;
			}

			dictionary[i] = counter++; // overwrite the dictionary object entry with the index of this entry
		}
	}

	if (counter > 0) {
		// Close the dictionary
		writeType(DataType.End);
	}

	return writeValue(input).flip().toBuffer();

	function writeValue(value, name) {
		var jsType = typeof value;

		// Turn string numbers into numbers
		if (typeof value === 'string' && value.match(/^-?[0-9]+$/)) {
			jsType = 'number';
			if (value <= MAX_UINT32) {
				value = parseInt(value, 10);
			}
		}

		switch (jsType) {
			case 'boolean':
				writeType(value ? DataType.BooleanTrue : DataType.BooleanFalse, name);
				break;

			case 'string':
				writeString(value, name);
				break;

			case 'number':
				if (isNaN(value)) {
					throw new TypeError("Cannot encode NaN into binary JSON.");
				}

				if (value % 1) {
					// This is a double
					writeDouble(value, name);
				} else {
					// This is an int. Figure out the most efficient encoding type.
					var isNegative = value < 0;
					if (isNegative) {
						value *= -1; // positiveize it
					}

					var type = DataType.PositiveInt64;
					var func = buffer.writeUint64;
					if (value < MAX_UINT8) {
						type = DataType.PositiveInt8;
						func = buffer.writeUint8;
					} else if (value < MAX_UINT16) {
						type = DataType.PositiveInt16;
						func = buffer.writeUint16;
					} else if (value < MAX_UINT32) {
						type = DataType.PositiveInt32;
						func = buffer.writeUint32;
					} else if (ByteBuffer.calculateVarint64(value) < 8) {
						type = DataType.PositiveVarInt64;
						func = buffer.writeVarint64;
					}

					if (isNegative) {
						++type;
					}

					writeType(type, name);
					func.call(buffer, value);
				}

				break;
			
			case 'object':
				// Here's the monster
				if (value === null) {
					writeType(DataType.Null, name);
					break;
				}

				if (value instanceof Array) {
					writeType(DataType.Array, name);
					value.forEach(function(i) {
						writeValue(i);
					});

					writeType(DataType.End);
					break;
				}

				writeType(DataType.Object, name);
				for (var i in value) {
					if (value.hasOwnProperty(i)) {
						writeValue(value[i], i);
					}
				}
				writeType(DataType.End);

				break;
		}

		return buffer;
	}

	function writeString(string, name) {
		if (dictionary.hasOwnProperty('str_' + string)) {
			writeType(DataType.DictionaryEntry);

			if (name) {
				writeString(name);
			}

			buffer.writeVarint64(dictionary['str_' + string]);
		} else {
			writeType(DataType.String, null, string);

			if (name) {
				writeString(name);
			}

			buffer.writeVString(string);
		}
	}

	function writeDouble(double, name) {
		if (dictionary.hasOwnProperty('dbl_' + double)) {
			writeType(DataType.DictionaryEntry);

			if (name) {
				writeString(name);
			}

			buffer.writeVarint64(dictionary['dbl_' + double]);
		} else {
			writeType(DataType.Double);

			if (name) {
				writeString(name);
			}

			buffer.writeDouble(double);
		}
	}

	function writeType(type, name, value) {
		var size = (type == DataType.String ? ByteBuffer.calculateVarint64(value.length) + value.length : 32);
		if (buffer.remaining() < size) {
			buffer.resize(buffer.limit + Math.max(size, 128));
		}

		buffer.writeUint8(type);
		if (name) {
			writeString(name);
		}

		return buffer;
	}

	function analyze(value) {
		if (typeof value === 'string' && value.length > 0) { // no savings on empty strings
			incrementDictionary('str', value);
		} else if (value instanceof Array) {
			value.forEach(analyze);
		} else if (typeof value === 'object' && value !== null) {
			for (var i in value) {
				if (value.hasOwnProperty(i)) {
					analyze(i);
					analyze(value[i]);
				}
			}
		} else if (typeof value === 'number' && value % 1 != 0) {
			// this is a double
			incrementDictionary('dbl', value);
		}
	}

	function incrementDictionary(type, value) {
		dictionary[type + '_' + value] = dictionary[type + '_' + value] || 0;
		++dictionary[type + '_' + value];
	}
};
