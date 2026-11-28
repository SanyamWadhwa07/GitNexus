package com.acme.billing

fun sampleAmounts(): List<Int> = listOf(100, 250)

class LedgerTest {
    fun closes(): String = formatCents(computeTotal(sampleAmounts()))
}
