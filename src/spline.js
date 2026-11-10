// Fling physics following Android's OverScroller spline, so momentum
// distance and duration feel like a native Android scroll view.
//
// The spline construction and the deceleration formulas are derived
// from the Android Open Source Project's `android.widget.OverScroller`
// (Copyright (C) 2010 The Android Open Source Project, Apache License
// 2.0).

const INFLEXION = 0.35
const START_TENSION = 0.5
const END_TENSION = 1.0
const P1 = START_TENSION * INFLEXION
const P2 = 1.0 - END_TENSION * (1.0 - INFLEXION)
const SAMPLES = 100
const DECELERATION_RATE = Math.log(0.78) / Math.log(0.9)
const GRAVITY_EARTH = 9.80665
const INCHES_PER_METER = 39.37
/// ViewConfiguration.getScrollFriction()
const SCROLL_FRICTION = 0.015

const SPLINE_POSITION = new Float64Array(SAMPLES + 1)

;(function build() {
	let xMin = 0
	for (let i = 0; i < SAMPLES; i++) {
		let alpha = i / SAMPLES
		let xMax = 1, x = 0, coef = 0
		for (;;) {
			x = xMin + (xMax - xMin) / 2
			coef = 3 * x * (1 - x)
			let tx = coef * ((1 - x) * P1 + x * P2) + x * x * x
			if (Math.abs(tx - alpha) < 1e-5) break
			if (tx > alpha) xMax = x
			else xMin = x
		}
		SPLINE_POSITION[i] = coef * ((1 - x) * START_TENSION + x) + x * x * x
	}
	SPLINE_POSITION[SAMPLES] = 1
})()

/**
 * Fraction of the fling distance covered at time fraction `t` (0..1).
 * @param {number} t
 * @returns {number}
 */
export function splinePosition(t) {
	if (t >= 1) return 1
	if (t <= 0) return 0
	let index = Math.floor(SAMPLES * t)
	let tInf = index / SAMPLES, tSup = (index + 1) / SAMPLES
	let dInf = SPLINE_POSITION[index], dSup = SPLINE_POSITION[index + 1]
	return dInf + (t - tInf) * (dSup - dInf) / (tSup - tInf)
}

/**
 * Fraction of the initial velocity remaining at time fraction `t`.
 * @param {number} t
 * @returns {number}
 */
export function splineVelocity(t) {
	if (t >= 1 || t < 0) return 0
	let index = Math.floor(SAMPLES * t)
	return (SPLINE_POSITION[index + 1] - SPLINE_POSITION[index]) * SAMPLES
}

/**
 * @typedef {Object} Fling
 * @property {number} distance - Signed distance in CSS px.
 * @property {number} duration - Duration in milliseconds.
 * @property {number} velocity - The initial velocity in CSS px per second.
 */

/**
 * Compute a fling for an initial velocity in CSS px/s on a screen
 * with the given device pixel ratio (Android's display density).
 * @param {number} velocity
 * @param {number} dpr
 * @returns {Fling}
 */
export function computeFling(velocity, dpr) {
	let physicalCoeff = GRAVITY_EARTH * INCHES_PER_METER * (160 * dpr) * 0.84
	let v = Math.abs(velocity) * dpr
	if (v < 1) return {distance: 0, duration: 0, velocity: 0}
	let l = Math.log(INFLEXION * v / (SCROLL_FRICTION * physicalCoeff))
	let duration = 1000 * Math.exp(l / (DECELERATION_RATE - 1))
	let distance = SCROLL_FRICTION * physicalCoeff * Math.exp(DECELERATION_RATE / (DECELERATION_RATE - 1) * l)
	return {distance: Math.sign(velocity) * distance / dpr, duration, velocity}
}

/**
 * Estimates release velocity like Android's default LSQ2 velocity
 * tracker: a quadratic least-squares fit over the last 100ms of
 * samples, evaluated at the newest sample.
 */
export class VelocityTracker {
	/** @type {number[]} */
	t = []
	/** @type {number[]} */
	x = []
	/** @type {number} */
	static horizon = 100
	/** @type {number} */
	static maxSamples = 20

	reset() {
		this.t.length = this.x.length = 0
	}

	/**
	 * @param {number} time
	 * @param {number} pos
	 */
	add(time, pos) {
		let n = this.t.length
		// A long pause means the finger stopped: older samples no longer
		// describe the current motion.
		if (n && time - this.t[n - 1] > 40) this.reset()
		this.t.push(time)
		this.x.push(pos)
		if (this.t.length > VelocityTracker.maxSamples) {
			this.t.shift()
			this.x.shift()
		}
	}

	/**
	 * Velocity in units per second at `now`. Zero if the pointer was
	 * still for a while before release.
	 * @param {number} now
	 * @returns {number}
	 */
	velocity(now) {
		let n = this.t.length
		if (n < 2) return 0
		let newest = this.t[n - 1]
		if (now - newest > 40) return 0
		let start = n - 1
		while (start > 0 && newest - this.t[start - 1] <= VelocityTracker.horizon) start--
		let count = n - start
		if (count < 2) return 0
		// Fit x(t) = a + b*t + c*t^2 with t in seconds relative to newest.
		let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, y0 = 0, y1 = 0, y2 = 0
		for (let i = start; i < n; i++) {
			let ti = (this.t[i] - newest) / 1000, xi = this.x[i]
			let t2 = ti * ti
			s0 += 1; s1 += ti; s2 += t2; s3 += t2 * ti; s4 += t2 * t2
			y0 += xi; y1 += xi * ti; y2 += xi * t2
		}
		if (count == 2) {
			let dt = (this.t[n - 1] - this.t[n - 2]) / 1000
			return dt > 0 ? (this.x[n - 1] - this.x[n - 2]) / dt : 0
		}
		// Solve the 3x3 normal equations with Cramer's rule.
		/**
		 * @param {number} a @param {number} b @param {number} c
		 * @param {number} d @param {number} e @param {number} f
		 * @param {number} g @param {number} h @param {number} i
		 * @returns {number}
		 */
		let det = (a, b, c, d, e, f, g, h, i) =>
			a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
		let D = det(s0, s1, s2, s1, s2, s3, s2, s3, s4)
		if (Math.abs(D) < 1e-12) {
			let dt = (this.t[n - 1] - this.t[start]) / 1000
			return dt > 0 ? (this.x[n - 1] - this.x[start]) / dt : 0
		}
		let Db = det(s0, y0, s2, s1, y1, s3, s2, y2, s4)
		return Db / D
	}
}
