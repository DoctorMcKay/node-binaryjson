// Load ByteBuffer
var ByteBuffer;
var BinaryJSON;
if (typeof dcodeIO !== 'undefined') {
	// We're in a browser
	ByteBuffer = dcodeIO.ByteBuffer;
	BinaryJSON = {};
} else {
	// We're in Node
	ByteBuffer = require('bytebuffer');
	BinaryJSON = exports;
}

(function() {
	var MAX_UINT8 = 255;
	var MAX_UINT16 = 65535;
	var MAX_UINT32 = 4294967295;

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

	BinaryJSON.decode = function(input) {
		var buffer = ByteBuffer.wrap(input, "binary", false);
		if (buffer.readUint8() == DataType.Dictionary) {
			--buffer.offset;
			var dictionaryStrings = [];
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
						if (type == DataType.Dictionary && typeof val[1] === 'string') {
							dictionaryStrings.push(val[1]);
						}

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
					if (!dictionary && !dictionaryStrings) {
						throw new Error("Tried to read dictionary entry without a provided dictionary");
					}

					data = (dictionary || dictionaryStrings)[buffer.readVarint64().toString()];
					break;
			}

			return [currentKeyName, data];
		}
	};

	BinaryJSON.encode = function(input) {
		var buffer = new ByteBuffer(128, false);
		var dictionary = {};
		var buildingDictionary = false;
		var buildingDictionaryStrings = false;
		var simulatingDictionary = true;
		var i;

		// Analyze our input for stuff we can put in the dictionary
		analyze(input);

		// We only care about items that appear more than once. Prune the useless ones.
		for (i in dictionary) {
			if (!dictionary.hasOwnProperty(i)) {
				continue;
			}

			if (dictionary[i].count <= 1) {
				delete dictionary[i];
			}
		}

		// Figure out which items are useless due to inclusion in a larger item
		writeValue(input);

		// Prune the unused ones
		simulatingDictionary = false;
		buildingDictionary = true;

		for (i in dictionary) {
			if (dictionary.hasOwnProperty(i) && typeof dictionary[i].value !== 'string' && !dictionary[i].used) {
				delete dictionary[i];
			}
		}

		// Sort the dictionary by how many times something appears (strings first), so most-frequently-used items appear first (and thus use less bytes)
		var counter = 0;
		var dictKeys = Object.keys(dictionary);
		var dictStrings = dictKeys.filter(function(key) { return typeof dictionary[key].value === 'string'; });
		var dictEverythingElse = dictKeys.filter(function(key) { return typeof dictionary[key].value !== 'string'; });
		dictStrings.sort(dictSort);
		dictEverythingElse.sort(dictSort);
		dictKeys = dictStrings.concat(dictEverythingElse);

		function dictSort(a, b) {
			if (dictionary[a].count == dictionary[b].count) {
				return 0;
			}

			return dictionary[a].count > dictionary[b].count ? -1 : 1;
		}

		dictKeys.forEach(function(i) {
			if (counter == 0) {
				// Go ahead and start the dictionary item
				writeType(DataType.Dictionary);
				buildingDictionaryStrings = true;
			}

			if (typeof dictionary[i].value !== 'string') {
				buildingDictionaryStrings = false;
			}

			writeValue(dictionary[i].value);
			dictionary[i].pos = counter++;
		});

		if (counter > 0) {
			// Close the dictionary
			writeType(DataType.End);
		}

		buildingDictionary = false;
		buildingDictionaryStrings = false;
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

			if (qualifiesForDictionary(value) && !buildingDictionaryStrings && (!buildingDictionary || typeof value === 'string')) {
				// See if it's already in the dictionary. If we're building the dictionary, then we can safely replace strings.
				var dictKey = getDictionaryKey(value);
				if (dictionary[dictKey]) {
					if (simulatingDictionary) {
						dictionary[dictKey].used = true;
					} else {
						writeType(DataType.DictionaryEntry, name).writeVarint64(dictionary[dictKey].pos);
					}

					return buffer;
				}
			}

			// If we're simulating, don't actually write anything
			if (simulatingDictionary && (typeof value !== 'object' || value === null)) {
				return buffer;
			}

			switch (jsType) {
				case 'boolean':
					writeType(value ? DataType.BooleanTrue : DataType.BooleanFalse, name);
					break;

				case 'string':
					writeType(DataType.String, name, value).writeVString(value);
					break;

				case 'number':
					if (isNaN(value)) {
						throw new TypeError("Cannot encode NaN into binary JSON.");
					}

					if (value % 1) {
						// This is a double
						writeType(DataType.Double, name).writeDouble(value);
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

		function writeType(type, name, value) {
			if (simulatingDictionary) {
				return buffer;
			}

			var size = (type == DataType.String ? ByteBuffer.calculateVarint64(value.length) + value.length : 32);
			if (buffer.remaining() < size) {
				buffer.resize(buffer.limit + Math.max(size, 128));
			}

			buffer.writeUint8(type);
			if (name) {
				writeValue(name);
			}

			return buffer;
		}

		function qualifiesForDictionary(value) {
			return !(value === null || typeof value === 'boolean' || (value.hasOwnProperty('length') && value.length <= 1) || (typeof value === 'number' && value % 1 == 0 && value < MAX_UINT16));
		}

		function analyze(value) {
			if (!qualifiesForDictionary(value)) {
				return; // this item cannot be put in the dictionary
			}

			incrementDictionary(value);

			// Also analyze everything this contains for maximum efficiency
			if (value instanceof Array) {
				value.forEach(analyze);
			} else if (typeof value === 'object' && value !== null) {
				for (var i in value) {
					if (value.hasOwnProperty(i)) {
						analyze(i);
						analyze(value[i]);
					}
				}
			}
		}

		function getDictionaryKey(value) {
			return typeof value + '_' + recursiveHash(value);
		}

		function incrementDictionary(value) {
			var key = getDictionaryKey(value);

			dictionary[key] = dictionary[key] || {"count": 0, "value": value};
			++dictionary[key].count;
		}
	};

	function recursiveHash(input) {
		return hex_sha1(recursiveBuildHash(input));
	}

	function recursiveBuildHash(input) {
		var toHash = "";
		if (input === null) {
			toHash += "null";
		} else {
			toHash += typeof input;
			if (input instanceof Array) {
				toHash += "array";
				input.forEach(function(item) {
					toHash += recursiveBuildHash(item);
				});
			} else if (typeof input === 'object') {
				// In JSON, order of keys doesn't matter
				var keys = Object.keys(input).sort();
				for (var i = 0; i < keys.length; i++) {
					toHash += keys[i];
					toHash += recursiveBuildHash(input[keys[i]]);
				}
			} else {
				toHash += input;
			}
		}

		return toHash;
	}

	// We aren't using require('crypto').createHash() because I want this to Just Work in the browser
	/*
	 * A JavaScript implementation of the Secure Hash Algorithm, SHA-1, as defined
	 * in FIPS PUB 180-1
	 * Version 2.1 Copyright Paul Johnston 2000 - 2002.
	 * Other contributors: Greg Holt, Andrew Kepert, Ydnar, Lostinet
	 * Distributed under the BSD License
	 * See http://pajhome.org.uk/crypt/md5 for details.
	 */
	function hex_sha1(s){return binb2hex(core_sha1(str2binb(s),s.length * 8));}

	function core_sha1(x, len)
	{
		x[len >> 5] |= 0x80 << (24 - len % 32);
		x[((len + 64 >> 9) << 4) + 15] = len;

		var w = new Array(80);
		var a =  1732584193;
		var b = -271733879;
		var c = -1732584194;
		var d =  271733878;
		var e = -1009589776;

		for(var i = 0; i < x.length; i += 16)
		{
			var olda = a;
			var oldb = b;
			var oldc = c;
			var oldd = d;
			var olde = e;

			for(var j = 0; j < 80; j++)
			{
				if(j < 16) w[j] = x[i + j];
				else w[j] = rol(w[j-3] ^ w[j-8] ^ w[j-14] ^ w[j-16], 1);
				var t = safe_add(safe_add(rol(a, 5), sha1_ft(j, b, c, d)),
					safe_add(safe_add(e, w[j]), sha1_kt(j)));
				e = d;
				d = c;
				c = rol(b, 30);
				b = a;
				a = t;
			}

			a = safe_add(a, olda);
			b = safe_add(b, oldb);
			c = safe_add(c, oldc);
			d = safe_add(d, oldd);
			e = safe_add(e, olde);
		}
		return [a, b, c, d, e];

	}

	function sha1_ft(t, b, c, d)
	{
		if(t < 20) return (b & c) | ((~b) & d);
		if(t < 40) return b ^ c ^ d;
		if(t < 60) return (b & c) | (b & d) | (c & d);
		return b ^ c ^ d;
	}

	function sha1_kt(t)
	{
		return (t < 20) ?  1518500249 : (t < 40) ?  1859775393 :
			(t < 60) ? -1894007588 : -899497514;
	}

	function safe_add(x, y)
	{
		var lsw = (x & 0xFFFF) + (y & 0xFFFF);
		var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
		return (msw << 16) | (lsw & 0xFFFF);
	}

	function rol(num, cnt)
	{
		return (num << cnt) | (num >>> (32 - cnt));
	}

	function str2binb(str)
	{
		var bin = [];
		var mask = (1 << 8) - 1;
		for(var i = 0; i < str.length * 8; i += 8)
			bin[i>>5] |= (str.charCodeAt(i / 8) & mask) << (24 - i%32);
		return bin;
	}

	function binb2hex(binarray)
	{
		var str = "";
		for(var i = 0; i < binarray.length * 4; i++)
		{
			str += ((binarray[i>>2] >> ((3 - i%4)*8+4)) & 0xF).toString(16) +
				((binarray[i>>2] >> ((3 - i%4)*8  )) & 0xF).toString(16);
		}
		return str;
	}
})();
